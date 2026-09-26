package schedule

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	managementSpacesPath      = "/api/management-spaces"
	readLinksPath             = "/api/read-links/"
	maximumCreationBodySize   = 8192
	maximumTurnstileTokenSize = 2048
	turnstileSiteverifyURL    = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	defaultScheduleTimeZone   = "America/Sao_Paulo"
)

var ErrUnauthorized = errors.New("management credential is invalid")

type ManagementSpaceView struct {
	ManagementSpace ManagementSpace `json:"managementSpace"`
	Schedules       []Schedule      `json:"schedules"`
	People          []Person        `json:"people"`
}

type ReadLink struct {
	ID         string `json:"id"`
	ScheduleID string `json:"scheduleId"`
	StartWeek  string `json:"startWeek"`
	WeekCount  int    `json:"weekCount"`
	Revoked    bool   `json:"revoked"`
}

type ReadLinkTarget struct {
	Schedule  Schedule
	Week      ScheduleWeek
	StartWeek string
	WeekCount int
}

type ReadLinkScheduleView struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	TimeZone string `json:"timeZone"`
}

type ReadLinkWeekView struct {
	WeekStart string                   `json:"weekStart"`
	WeekEnd   string                   `json:"weekEnd"`
	TimeZone  string                   `json:"timeZone"`
	People    []ReadLinkPersonWeekView `json:"people"`
}

type ReadLinkPersonWeekView struct {
	Person Person            `json:"person"`
	Days   []ReadLinkDayView `json:"days"`
}

type ReadLinkDayView struct {
	Date       string      `json:"date"`
	Weekday    int         `json:"weekday"`
	State      string      `json:"state"`
	WorkPeriod *WorkPeriod `json:"workPeriod,omitempty"`
}

type ReadLinkResponse struct {
	Schedule  ReadLinkScheduleView `json:"schedule"`
	Week      ReadLinkWeekView     `json:"week"`
	StartWeek string               `json:"startWeek"`
	WeekCount int                  `json:"weekCount"`
}

type ManagementSpaceStore interface {
	CreateManagementSpace(context.Context, ManagementSpace, Schedule, string) error
	GetManagementSpace(context.Context, string, string) (ManagementSpaceView, error)
	ReplaceManagementToken(context.Context, string, string, string) (bool, error)
	RenameManagementSpace(context.Context, string, string, string) (ManagementSpace, error)
	RenameManagementSchedule(context.Context, string, string, string, string) (Schedule, error)
}

type SchedulingStore interface {
	CreateSchedule(context.Context, string, string, Schedule) error
	CreatePerson(context.Context, string, string, Person) error
	UpdateScheduleTimeZone(context.Context, string, string, string, string) (Schedule, error)
	CreateParticipation(context.Context, string, string, string, WeekParticipation, string, string) error
	SaveScheduleEdit(context.Context, string, string, string, string, ScheduleEdit, string) error
}

type ReadLinkStore interface {
	CreateReadLink(context.Context, string, string, string, ReadLink, string) error
	ListReadLinks(context.Context, string, string, string) ([]ReadLink, error)
	RevokeReadLink(context.Context, string, string, string, string) error
	GetReadLinkWeek(context.Context, string, string, string, string) (ReadLinkTarget, error)
}

type TurnstileVerifier interface {
	Verify(context.Context, string, string, string) (bool, error)
}

type CreationRateLimiter interface {
	Allow(context.Context, string) (bool, error)
}

type ManagementSecurity struct {
	ChallengeVerifier      TurnstileVerifier
	CreationRateLimiter    CreationRateLimiter
	ChallengeHostname      string
	CreationPaused         bool
	QuotaMonitoringEnabled bool
	QuotaMonitoringReady   bool
	QuotaUsage             FreeQuotaUsage
}

type turnstileVerifier struct {
	secretKey string
	client    *http.Client
}

func NewTurnstileVerifier(secretKey string) TurnstileVerifier {
	return &turnstileVerifier{
		secretKey: secretKey,
		client:    &http.Client{Timeout: 5 * time.Second},
	}
}

func (verifier *turnstileVerifier) Verify(ctx context.Context, token, remoteIP, expectedHostname string) (bool, error) {
	if strings.TrimSpace(verifier.secretKey) == "" {
		return false, errors.New("Turnstile secret is not configured")
	}

	body, err := json.Marshal(struct {
		Secret   string `json:"secret"`
		Response string `json:"response"`
		RemoteIP string `json:"remoteip,omitempty"`
	}{Secret: verifier.secretKey, Response: token, RemoteIP: remoteIP})
	if err != nil {
		return false, errors.New("could not prepare Turnstile verification")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, turnstileSiteverifyURL, bytes.NewReader(body))
	if err != nil {
		return false, errors.New("could not prepare Turnstile verification")
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := verifier.client.Do(request)
	if err != nil {
		return false, errors.New("Turnstile verification is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false, errors.New("Turnstile verification is unavailable")
	}

	var result struct {
		Success  bool   `json:"success"`
		Hostname string `json:"hostname"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 32*1024)).Decode(&result); err != nil {
		return false, errors.New("Turnstile verification returned an invalid response")
	}
	if !result.Success {
		return false, nil
	}
	return expectedHostname != "" && strings.EqualFold(result.Hostname, expectedHostname), nil
}

func (api *handler) createManagementSpace(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", "POST, OPTIONS")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !api.managementEnabled() {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	if api.managementSecurity.CreationPaused ||
		(api.managementSecurity.QuotaMonitoringEnabled && !api.managementSecurity.QuotaMonitoringReady) ||
		api.managementSecurity.QuotaUsage.ApproachingFreeLimit() {
		writeError(response, http.StatusServiceUnavailable, "creation_paused")
		return
	}
	if api.managementSecurity.ChallengeVerifier == nil || api.managementSecurity.CreationRateLimiter == nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}

	clientIP := net.ParseIP(strings.TrimSpace(request.Header.Get("CF-Connecting-IP")))
	if clientIP == nil {
		writeError(response, http.StatusBadRequest, "invalid_request")
		return
	}
	clientIPString := clientIP.String()
	ipDigest := sha256.Sum256([]byte(clientIPString))
	allowed, err := api.managementSecurity.CreationRateLimiter.Allow(request.Context(), hex.EncodeToString(ipDigest[:]))
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	if !allowed {
		writeError(response, http.StatusTooManyRequests, "creation_rate_limited")
		return
	}

	var payload struct {
		SpaceName      string `json:"spaceName"`
		ScheduleName   string `json:"scheduleName"`
		TimeZone       string `json:"timeZone"`
		TurnstileToken string `json:"turnstileToken"`
	}
	if err := decodeJSONBody(request, maximumCreationBodySize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_request")
		return
	}
	payload.SpaceName = strings.TrimSpace(payload.SpaceName)
	payload.ScheduleName = strings.TrimSpace(payload.ScheduleName)
	if payload.TimeZone == "" {
		payload.TimeZone = defaultScheduleTimeZone
	}
	if !validName(payload.SpaceName) || !validName(payload.ScheduleName) || len(payload.TurnstileToken) > maximumTurnstileTokenSize {
		writeError(response, http.StatusBadRequest, "invalid_request")
		return
	}
	if !validScheduleTimeZone(payload.TimeZone) {
		writeError(response, http.StatusBadRequest, "invalid_time_zone")
		return
	}

	expectedHostname := api.managementSecurity.ChallengeHostname
	if expectedHostname == "" {
		expectedHostname = api.allowedOriginHost()
	}
	verified, err := api.managementSecurity.ChallengeVerifier.Verify(request.Context(), payload.TurnstileToken, clientIPString, expectedHostname)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "challenge_unavailable")
		return
	}
	if !verified {
		writeError(response, http.StatusBadRequest, "challenge_failed")
		return
	}

	spaceID, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	scheduleID, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	scheduleRevision, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	token, err := newManagementToken()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	managementSpace := ManagementSpace{ID: spaceID, Name: payload.SpaceName}
	firstSchedule := Schedule{
		ID:              scheduleID,
		Name:            payload.ScheduleName,
		TimeZone:        payload.TimeZone,
		Revision:        scheduleRevision,
		ManagementSpace: managementSpace,
	}
	if err := api.managementStore.CreateManagementSpace(request.Context(), managementSpace, firstSchedule, tokenHash(token)); err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, struct {
		ManagementSpace ManagementSpace `json:"managementSpace"`
		Schedule        Schedule        `json:"schedule"`
		ManagementToken string          `json:"managementToken"`
	}{ManagementSpace: managementSpace, Schedule: firstSchedule, ManagementToken: token})
}

func (api *handler) managementSpaceRequest(response http.ResponseWriter, request *http.Request) {
	if !api.managementEnabled() {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, managementSpacesPath+"/"), "/")
	replacingLink := len(parts) == 2 && parts[1] == "management-link"
	route := ""
	switch {
	case len(parts) == 1:
		route = "space"
	case len(parts) == 2 && parts[1] == "people":
		route = "people"
	case len(parts) == 2 && parts[1] == "schedules":
		route = "schedules"
	case len(parts) == 3 && parts[1] == "schedules":
		route = "schedule"
	case len(parts) == 4 && parts[1] == "schedules" && parts[3] == "read-links":
		route = "read-links"
	case len(parts) == 5 && parts[1] == "schedules" && parts[3] == "read-links":
		route = "read-link"
	case len(parts) == 4 && parts[1] == "schedules" && parts[3] == "participations":
		route = "participations"
	case len(parts) == 6 && parts[1] == "schedules" && parts[3] == "participations" && parts[5] == "edits":
		route = "edits"
	}
	if route == "" && !replacingLink {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	spaceID := parts[0]
	if !isUUID(spaceID) || (len(parts) >= 3 && parts[1] == "schedules" && !isUUID(parts[2])) || (route == "edits" && !isUUID(parts[4])) || (route == "read-link" && !isUUID(parts[4])) {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	if replacingLink {
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", "POST, OPTIONS")
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
			return
		}
		token, ok := managementBearerToken(request.Header.Get("Authorization"))
		if !ok {
			response.Header().Set("WWW-Authenticate", "Bearer")
			writeError(response, http.StatusUnauthorized, "unauthorized")
			return
		}
		api.replaceManagementLink(response, request, spaceID, token)
		return
	}
	allowed := false
	allow := ""
	switch route {
	case "space", "schedule":
		allowed = request.Method == http.MethodGet || request.Method == http.MethodPatch
		allow = "GET, PATCH, OPTIONS"
	case "people", "schedules", "participations", "edits":
		allowed = request.Method == http.MethodPost
		allow = "POST, OPTIONS"
	case "read-links":
		allowed = request.Method == http.MethodGet || request.Method == http.MethodPost
		allow = "GET, POST, OPTIONS"
	case "read-link":
		allowed = request.Method == http.MethodDelete
		allow = "DELETE, OPTIONS"
	}
	if !allowed {
		response.Header().Set("Allow", allow)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	token, ok := managementBearerToken(request.Header.Get("Authorization"))
	if !ok {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized")
		return
	}
	space, err := api.managementStore.GetManagementSpace(request.Context(), spaceID, tokenHash(token))
	if err != nil {
		writeStoreError(response, err)
		return
	}
	credentialHash := tokenHash(token)
	switch route {
	case "space":
		if request.Method == http.MethodGet {
			writeJSON(response, http.StatusOK, space)
		} else {
			api.renameManagementSpace(response, request, spaceID, credentialHash)
		}
	case "people":
		api.createPerson(response, request, spaceID, credentialHash)
	case "schedules":
		api.createSchedule(response, request, spaceID, credentialHash)
	case "schedule":
		if request.Method == http.MethodGet {
			weekStart := request.URL.Query().Get("weekStart")
			if weekStart == "" {
				writeJSON(response, http.StatusOK, space)
				return
			}
			api.getScheduleWeek(response, space, parts[2], weekStart)
		} else {
			api.updateManagementSchedule(response, request, spaceID, parts[2], credentialHash)
		}
	case "participations":
		api.createParticipation(response, request, space, spaceID, parts[2], credentialHash)
	case "edits":
		api.saveScheduleEdit(response, request, space, spaceID, parts[2], parts[4], credentialHash)
	case "read-links":
		if request.Method == http.MethodGet {
			api.listReadLinks(response, request, space, spaceID, parts[2], credentialHash)
		} else {
			api.createReadLink(response, request, space, spaceID, parts[2], credentialHash)
		}
	case "read-link":
		api.revokeReadLink(response, request, space, spaceID, parts[2], parts[4], credentialHash)
	}
}

func (api *handler) readLinkRequest(response http.ResponseWriter, request *http.Request) {
	if !api.managementEnabled() {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", "GET, OPTIONS")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	parts := strings.Split(strings.TrimPrefix(request.URL.Path, readLinksPath), "/")
	if len(parts) != 5 || parts[1] != "schedules" || parts[3] != "weeks" || !isUUID(parts[0]) || !isUUID(parts[2]) {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	weekStart := parts[4]
	if !validReadLinkScope(weekStart, 1) {
		writeError(response, http.StatusUnauthorized, "unauthorized")
		return
	}
	token, ok := managementBearerToken(request.Header.Get("Authorization"))
	if !ok {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized")
		return
	}
	store, ok := api.managementStore.(ReadLinkStore)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	target, err := store.GetReadLinkWeek(request.Context(), parts[0], parts[2], tokenHash(token), weekStart)
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, projectReadLinkResponse(target))
}

func (api *handler) listReadLinks(response http.ResponseWriter, request *http.Request, space ManagementSpaceView, spaceID, scheduleID, managementHash string) {
	if _, found := findSchedule(space, scheduleID); !found {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	store, ok := api.managementStore.(ReadLinkStore)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	links, err := store.ListReadLinks(request.Context(), spaceID, scheduleID, managementHash)
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		ReadLinks []ReadLink `json:"readLinks"`
	}{ReadLinks: links})
}

func (api *handler) createReadLink(response http.ResponseWriter, request *http.Request, space ManagementSpaceView, spaceID, scheduleID, managementHash string) {
	if _, found := findSchedule(space, scheduleID); !found {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	var payload struct {
		StartWeek string `json:"startWeek"`
		WeekCount int    `json:"weekCount"`
	}
	if err := decodeJSONBody(request, maximumRequestSize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_read_link")
		return
	}
	if !validReadLinkScope(payload.StartWeek, payload.WeekCount) {
		writeError(response, http.StatusBadRequest, "invalid_read_link")
		return
	}
	store, ok := api.managementStore.(ReadLinkStore)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	linkID, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	token, err := newManagementToken()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	link := ReadLink{ID: linkID, ScheduleID: scheduleID, StartWeek: payload.StartWeek, WeekCount: payload.WeekCount}
	if err := store.CreateReadLink(request.Context(), spaceID, scheduleID, managementHash, link, tokenHash(token)); err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, struct {
		ReadLink  ReadLink `json:"readLink"`
		ReadToken string   `json:"readToken"`
	}{ReadLink: link, ReadToken: token})
}

func (api *handler) revokeReadLink(response http.ResponseWriter, request *http.Request, space ManagementSpaceView, spaceID, scheduleID, linkID, managementHash string) {
	if _, found := findSchedule(space, scheduleID); !found {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	store, ok := api.managementStore.(ReadLinkStore)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	if err := store.RevokeReadLink(request.Context(), spaceID, scheduleID, linkID, managementHash); err != nil {
		writeStoreError(response, err)
		return
	}
	response.WriteHeader(http.StatusNoContent)
}

func validReadLinkScope(startWeek string, weekCount int) bool {
	if weekCount < 1 || weekCount > 4 {
		return false
	}
	start, err := parseCalendarDate(startWeek)
	return err == nil && start.Format("2006-01-02") == startWeek && start.Weekday() == time.Monday
}

func projectReadLinkResponse(target ReadLinkTarget) ReadLinkResponse {
	response := ReadLinkResponse{
		Schedule:  ReadLinkScheduleView{ID: target.Schedule.ID, Name: target.Schedule.Name, TimeZone: target.Schedule.TimeZone},
		StartWeek: target.StartWeek,
		WeekCount: target.WeekCount,
		Week: ReadLinkWeekView{
			WeekStart: target.Week.WeekStart,
			WeekEnd:   target.Week.WeekEnd,
			TimeZone:  target.Week.TimeZone,
			People:    make([]ReadLinkPersonWeekView, 0, len(target.Week.People)),
		},
	}
	for _, personWeek := range target.Week.People {
		readerPerson := ReadLinkPersonWeekView{Person: personWeek.Person, Days: make([]ReadLinkDayView, 0, len(personWeek.Days))}
		for _, day := range personWeek.Days {
			state := day.State
			if state == DayStateMedicalLeave {
				state = "unavailable"
			}
			readerPerson.Days = append(readerPerson.Days, ReadLinkDayView{
				Date: day.Date, Weekday: day.Weekday, State: state, WorkPeriod: day.WorkPeriod,
			})
		}
		response.Week.People = append(response.Week.People, readerPerson)
	}
	return response
}

func (api *handler) replaceManagementLink(response http.ResponseWriter, request *http.Request, spaceID, currentToken string) {
	nextToken, err := newManagementToken()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	replaced, err := api.managementStore.ReplaceManagementToken(request.Context(), spaceID, tokenHash(currentToken), tokenHash(nextToken))
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	if !replaced {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(response, http.StatusOK, struct {
		ManagementToken string `json:"managementToken"`
	}{ManagementToken: nextToken})
}

func (api *handler) renameManagementSpace(response http.ResponseWriter, request *http.Request, spaceID, credentialHash string) {
	var payload struct {
		Name string `json:"name"`
	}
	if err := decodeJSONBody(request, maximumRequestSize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_management_space_name")
		return
	}
	name := strings.TrimSpace(payload.Name)
	if !validName(name) {
		writeError(response, http.StatusBadRequest, "invalid_management_space_name")
		return
	}
	managementSpace, err := api.managementStore.RenameManagementSpace(request.Context(), spaceID, credentialHash, name)
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		ManagementSpace ManagementSpace `json:"managementSpace"`
	}{ManagementSpace: managementSpace})
}

func (api *handler) renameManagementSchedule(response http.ResponseWriter, request *http.Request, spaceID, scheduleID, credentialHash string) {
	var payload struct {
		Name string `json:"name"`
	}
	if err := decodeJSONBody(request, maximumRequestSize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_schedule_name")
		return
	}
	name := strings.TrimSpace(payload.Name)
	if !validName(name) {
		writeError(response, http.StatusBadRequest, "invalid_schedule_name")
		return
	}
	schedule, err := api.managementStore.RenameManagementSchedule(request.Context(), spaceID, scheduleID, credentialHash, name)
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		Schedule Schedule `json:"schedule"`
	}{Schedule: schedule})
}

func (api *handler) updateManagementSchedule(response http.ResponseWriter, request *http.Request, spaceID, scheduleID, credentialHash string) {
	var payload struct {
		Name     string `json:"name"`
		TimeZone string `json:"timeZone"`
	}
	if err := decodeJSONBody(request, maximumRequestSize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_schedule")
		return
	}
	payload.Name = strings.TrimSpace(payload.Name)
	if payload.Name == "" && payload.TimeZone == "" {
		writeError(response, http.StatusBadRequest, "invalid_schedule")
		return
	}
	if payload.Name != "" && !validName(payload.Name) {
		writeError(response, http.StatusBadRequest, "invalid_schedule_name")
		return
	}
	if payload.TimeZone != "" && !validScheduleTimeZone(payload.TimeZone) {
		writeError(response, http.StatusBadRequest, "invalid_time_zone")
		return
	}

	var result Schedule
	if payload.Name != "" {
		renamed, err := api.managementStore.RenameManagementSchedule(request.Context(), spaceID, scheduleID, credentialHash, payload.Name)
		if err != nil {
			writeStoreError(response, err)
			return
		}
		result = renamed
	}
	if payload.TimeZone != "" {
		store, ok := api.managementStore.(SchedulingStore)
		if !ok {
			writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
			return
		}
		updated, err := store.UpdateScheduleTimeZone(request.Context(), spaceID, scheduleID, credentialHash, payload.TimeZone)
		if err != nil {
			writeStoreError(response, err)
			return
		}
		result = updated
	}
	writeJSON(response, http.StatusOK, struct {
		Schedule Schedule `json:"schedule"`
	}{Schedule: result})
}

func (api *handler) createSchedule(response http.ResponseWriter, request *http.Request, spaceID, credentialHash string) {
	var payload struct {
		Name     string `json:"name"`
		TimeZone string `json:"timeZone"`
	}
	if err := decodeJSONBody(request, maximumCreationBodySize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_schedule")
		return
	}
	payload.Name = strings.TrimSpace(payload.Name)
	if payload.TimeZone == "" {
		payload.TimeZone = defaultScheduleTimeZone
	}
	if !validName(payload.Name) {
		writeError(response, http.StatusBadRequest, "invalid_schedule_name")
		return
	}
	if !validScheduleTimeZone(payload.TimeZone) {
		writeError(response, http.StatusBadRequest, "invalid_time_zone")
		return
	}
	store, ok := api.managementStore.(SchedulingStore)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	id, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	revision, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	schedule := Schedule{ID: id, Name: payload.Name, TimeZone: payload.TimeZone, Revision: revision, ManagementSpace: ManagementSpace{ID: spaceID}}
	if err := store.CreateSchedule(request.Context(), spaceID, credentialHash, schedule); err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, struct {
		Schedule Schedule `json:"schedule"`
	}{Schedule: schedule})
}

func (api *handler) createPerson(response http.ResponseWriter, request *http.Request, spaceID, credentialHash string) {
	var payload struct {
		Name string `json:"name"`
	}
	if err := decodeJSONBody(request, maximumRequestSize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_person")
		return
	}
	person := Person{Name: strings.TrimSpace(payload.Name)}
	if !validName(person.Name) {
		writeError(response, http.StatusBadRequest, "invalid_person_name")
		return
	}
	store, ok := api.managementStore.(SchedulingStore)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	id, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	person.ID = id
	if err := store.CreatePerson(request.Context(), spaceID, credentialHash, person); err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, struct {
		Person Person `json:"person"`
	}{Person: person})
}

func (api *handler) createParticipation(response http.ResponseWriter, request *http.Request, space ManagementSpaceView, spaceID, scheduleID, credentialHash string) {
	var payload struct {
		PersonID  string        `json:"personId"`
		StartDate string        `json:"startDate"`
		EndDate   *string       `json:"endDate"`
		Pattern   WeeklyPattern `json:"pattern"`
	}
	if err := decodeJSONBody(request, maximumCreationBodySize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_participation")
		return
	}
	if !isUUID(payload.PersonID) || validateParticipationDates(payload.StartDate, payload.EndDate) != nil || validatePatternVersion(payload.Pattern) != nil {
		writeError(response, http.StatusBadRequest, "invalid_participation")
		return
	}
	if payload.Pattern.EffectiveFrom > payload.StartDate {
		writeError(response, http.StatusBadRequest, "invalid_participation")
		return
	}
	participationID, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	if payload.Pattern.ID == "" {
		payload.Pattern.ID, err = newUUID()
		if err != nil {
			writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
			return
		}
	}
	calendar, found := findSchedule(space, scheduleID)
	if !found {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	nextRevision, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	participation := WeekParticipation{
		ID:                 participationID,
		Person:             Person{ID: payload.PersonID},
		ParticipationStart: payload.StartDate,
		ParticipationEnd:   payload.EndDate,
		PatternVersions:    []WeeklyPattern{payload.Pattern},
	}
	store, ok := api.managementStore.(SchedulingStore)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	if err := store.CreateParticipation(request.Context(), spaceID, scheduleID, credentialHash, participation, calendar.Revision, nextRevision); err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, struct {
		Participation WeekParticipation `json:"participation"`
		Revision      string            `json:"revision"`
	}{Participation: participation, Revision: nextRevision})
}

func (api *handler) saveScheduleEdit(response http.ResponseWriter, request *http.Request, space ManagementSpaceView, spaceID, scheduleID, participationID, credentialHash string) {
	var edit ScheduleEdit
	if err := decodeJSONBody(request, maximumCreationBodySize, &edit); err != nil {
		writeJSONBodyError(response, err, "invalid_schedule_edit")
		return
	}
	calendar, found := findSchedule(space, scheduleID)
	if !found {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	participation, found := findParticipation(space, scheduleID, participationID)
	if !found {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	if edit.Revision != calendar.Revision {
		writeError(response, http.StatusConflict, "stale_schedule_edit")
		return
	}
	if err := ValidateScheduleEdit(calendar, participation, edit, time.Now()); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_schedule_edit")
		return
	}
	for index := range edit.Dates {
		id, err := newUUID()
		if err != nil {
			writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
			return
		}
		edit.Dates[index].ID = id
	}
	if edit.Mode == ScheduleEditRecurring {
		id, err := newUUID()
		if err != nil {
			writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
			return
		}
		edit.PatternID = id
	}
	nextRevision, err := newUUID()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	store, ok := api.managementStore.(SchedulingStore)
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	if err := store.SaveScheduleEdit(request.Context(), spaceID, scheduleID, participationID, credentialHash, edit, nextRevision); err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, struct {
		Revision string `json:"revision"`
	}{Revision: nextRevision})
}

func findParticipation(space ManagementSpaceView, scheduleID, participationID string) (WeekParticipation, bool) {
	for _, calendar := range space.Schedules {
		if calendar.ID != scheduleID {
			continue
		}
		for _, participation := range calendar.Participations {
			if participation.ID == participationID {
				return participation, true
			}
		}
	}
	return WeekParticipation{}, false
}

func findSchedule(space ManagementSpaceView, scheduleID string) (Schedule, bool) {
	for _, calendar := range space.Schedules {
		if calendar.ID == scheduleID {
			return calendar, true
		}
	}
	return Schedule{}, false
}

func (api *handler) getScheduleWeek(response http.ResponseWriter, space ManagementSpaceView, scheduleID, weekStart string) {
	for _, calendar := range space.Schedules {
		if calendar.ID != scheduleID {
			continue
		}
		week, err := DeriveScheduleWeek(calendar, weekStart, calendar.Participations, time.Now())
		if err != nil {
			writeError(response, http.StatusBadRequest, "invalid_schedule_week")
			return
		}
		writeJSON(response, http.StatusOK, struct {
			Week ScheduleWeek `json:"week"`
		}{Week: week})
		return
	}
	writeError(response, http.StatusNotFound, "not_found")
}

func (api *handler) managementEnabled() bool {
	return api.managementStore != nil && (api.appEnv == "preview" || api.appEnv == "production")
}

func validName(name string) bool {
	return name != "" && utf8.RuneCountInString(name) <= maximumNameLength
}

func managementBearerToken(authorization string) (string, bool) {
	if len(authorization) > 256 {
		return "", false
	}
	parts := strings.Fields(authorization)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) < 32 || len(parts[1]) > 128 {
		return "", false
	}
	return parts[1], true
}

func tokenHash(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func newManagementToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate management credential: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func newUUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate identifier: %w", err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(value)
	return encoded[:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:], nil
}

func isUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func (api *handler) allowedOriginHost() string {
	origin, err := url.Parse(api.webOrigin)
	if err != nil {
		return ""
	}
	return origin.Hostname()
}
