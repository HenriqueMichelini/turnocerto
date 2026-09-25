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
	maximumCreationBodySize   = 8192
	maximumTurnstileTokenSize = 2048
	turnstileSiteverifyURL    = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
)

var ErrUnauthorized = errors.New("management credential is invalid")

type ManagementSpaceView struct {
	ManagementSpace ManagementSpace `json:"managementSpace"`
	Schedules       []Schedule      `json:"schedules"`
}

type ManagementSpaceStore interface {
	CreateManagementSpace(context.Context, ManagementSpace, Schedule, string) error
	GetManagementSpace(context.Context, string, string) (ManagementSpaceView, error)
	ReplaceManagementToken(context.Context, string, string, string) (bool, error)
	RenameManagementSpace(context.Context, string, string, string) (ManagementSpace, error)
	RenameManagementSchedule(context.Context, string, string, string, string) (Schedule, error)
}

type TurnstileVerifier interface {
	Verify(context.Context, string, string, string) (bool, error)
}

type CreationRateLimiter interface {
	Allow(context.Context, string) (bool, error)
}

type ManagementSecurity struct {
	ChallengeVerifier   TurnstileVerifier
	CreationRateLimiter CreationRateLimiter
	ChallengeHostname   string
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
		TurnstileToken string `json:"turnstileToken"`
	}
	if err := decodeJSONBody(request, maximumCreationBodySize, &payload); err != nil {
		writeJSONBodyError(response, err, "invalid_request")
		return
	}
	payload.SpaceName = strings.TrimSpace(payload.SpaceName)
	payload.ScheduleName = strings.TrimSpace(payload.ScheduleName)
	if !validName(payload.SpaceName) || !validName(payload.ScheduleName) || len(payload.TurnstileToken) > maximumTurnstileTokenSize {
		writeError(response, http.StatusBadRequest, "invalid_request")
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
	token, err := newManagementToken()
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
		return
	}
	managementSpace := ManagementSpace{ID: spaceID, Name: payload.SpaceName}
	firstSchedule := Schedule{
		ID:              scheduleID,
		Name:            payload.ScheduleName,
		ManagementSpace: managementSpace,
	}
	if err := api.managementStore.CreateManagementSpace(request.Context(), managementSpace, firstSchedule, tokenHash(token)); err != nil {
		writeError(response, http.StatusServiceUnavailable, "temporarily_unavailable")
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
	if len(parts) != 1 && !(len(parts) == 3 && parts[1] == "schedules") && !replacingLink {
		writeError(response, http.StatusNotFound, "not_found")
		return
	}
	spaceID := parts[0]
	if !isUUID(spaceID) || (len(parts) == 3 && !isUUID(parts[2])) {
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
	if request.Method != http.MethodGet && !(request.Method == http.MethodPatch && (len(parts) == 1 || len(parts) == 3)) {
		response.Header().Set("Allow", "GET, PATCH, OPTIONS")
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
	if request.Method == http.MethodGet {
		writeJSON(response, http.StatusOK, space)
		return
	}
	if len(parts) == 1 {
		api.renameManagementSpace(response, request, parts[0], tokenHash(token))
		return
	}
	api.renameManagementSchedule(response, request, parts[0], parts[2], tokenHash(token))
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
