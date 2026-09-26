package schedule_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

type readLinkStoreStub struct {
	*schedulingManagementSpaceStore
	links           map[string]schedule.ReadLink
	readTokenHashes map[string]string
	target          schedule.ReadLinkTarget
}

func newReadLinkStoreStub() *readLinkStoreStub {
	return &readLinkStoreStub{
		schedulingManagementSpaceStore: newSchedulingManagementSpaceStore(),
		links:                          make(map[string]schedule.ReadLink),
		readTokenHashes:                make(map[string]string),
		target: schedule.ReadLinkTarget{
			Schedule: schedule.Schedule{ID: "22222222-2222-4222-8222-222222222222", Name: "Equipe privada", TimeZone: "America/Sao_Paulo"},
			Week: schedule.ScheduleWeek{
				WeekStart: "2026-09-21",
				WeekEnd:   "2026-09-27",
				TimeZone:  "America/Sao_Paulo",
				People: []schedule.PersonWeek{{
					Person: schedule.Person{ID: "33333333-3333-4333-8333-333333333333", Name: "Ana"},
					Days: []schedule.ScheduleDay{
						{Date: "2026-09-21", Weekday: 1, State: schedule.DayStateMedicalLeave, PatternState: schedule.DayStateWorkPeriod, HasException: true},
					},
				}},
			},
			StartWeek: "2026-09-21",
			WeekCount: 2,
		},
	}
}

func (store *readLinkStoreStub) CreateReadLink(_ context.Context, spaceID, scheduleID, managementHash string, link schedule.ReadLink, readTokenHash string) error {
	if store.tokenHashes[spaceID] != managementHash {
		return schedule.ErrUnauthorized
	}
	if spaceID != "11111111-1111-4111-8111-111111111111" || scheduleID != store.target.Schedule.ID {
		return schedule.ErrNotFound
	}
	store.links[link.ID] = link
	store.readTokenHashes[link.ID] = readTokenHash
	return nil
}

func (store *readLinkStoreStub) ListReadLinks(_ context.Context, spaceID, scheduleID, managementHash string) ([]schedule.ReadLink, error) {
	if store.tokenHashes[spaceID] != managementHash {
		return nil, schedule.ErrUnauthorized
	}
	if scheduleID != store.target.Schedule.ID {
		return nil, schedule.ErrNotFound
	}
	links := make([]schedule.ReadLink, 0, len(store.links))
	for _, link := range store.links {
		if link.ScheduleID == scheduleID {
			links = append(links, link)
		}
	}
	return links, nil
}

func (store *readLinkStoreStub) RevokeReadLink(_ context.Context, spaceID, scheduleID, linkID, managementHash string) error {
	if store.tokenHashes[spaceID] != managementHash {
		return schedule.ErrUnauthorized
	}
	link, exists := store.links[linkID]
	if !exists || link.ScheduleID != scheduleID || link.Revoked {
		return schedule.ErrNotFound
	}
	link.Revoked = true
	store.links[linkID] = link
	return nil
}

func (store *readLinkStoreStub) GetReadLinkWeek(_ context.Context, linkID, scheduleID, readTokenHash, weekStart string) (schedule.ReadLinkTarget, error) {
	link, exists := store.links[linkID]
	if !exists || link.ScheduleID != scheduleID || link.Revoked || store.readTokenHashes[linkID] != readTokenHash {
		return schedule.ReadLinkTarget{}, schedule.ErrUnauthorized
	}
	requestedWeek, requestedErr := time.Parse("2006-01-02", weekStart)
	startWeek, startErr := time.Parse("2006-01-02", link.StartWeek)
	if requestedErr != nil || startErr != nil || requestedWeek.Before(startWeek) || requestedWeek.After(startWeek.AddDate(0, 0, (link.WeekCount-1)*7)) {
		return schedule.ReadLinkTarget{}, schedule.ErrUnauthorized
	}
	target := store.target
	target.Week.WeekStart = weekStart
	return target, nil
}

func TestReadLinkIssuanceStoresOnlyTokenHashAndEnforcesFixedWeekRange(t *testing.T) {
	store := newReadLinkStoreStub()
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	spaceID := "11111111-1111-4111-8111-111111111111"
	scheduleID := "22222222-2222-4222-8222-222222222222"
	response := managementRequest(handler, http.MethodPost,
		"/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"/read-links", previewToken,
		`{"startWeek":"2026-09-21","weekCount":2}`)
	if response.Code != http.StatusCreated {
		t.Fatalf("create read link status = %d, want %d; body=%s", response.Code, http.StatusCreated, response.Body)
	}
	var result struct {
		ReadLink schedule.ReadLink `json:"readLink"`
		Token    string            `json:"readToken"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Token) != 43 || result.ReadLink.WeekCount != 2 || result.ReadLink.StartWeek != "2026-09-21" {
		t.Fatalf("issued link = %#v with token length %d", result.ReadLink, len(result.Token))
	}
	if store.readTokenHashes[result.ReadLink.ID] != hashManagementToken(result.Token) {
		t.Fatal("read link store did not receive the token hash")
	}
	if strings.Contains(response.Body.String(), store.readTokenHashes[result.ReadLink.ID]) {
		t.Fatal("issuance response exposed the stored token hash")
	}
	listed := managementRequest(handler, http.MethodGet,
		"/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"/read-links", previewToken, "")
	if listed.Code != http.StatusOK || strings.Contains(listed.Body.String(), result.Token) || strings.Contains(listed.Body.String(), store.readTokenHashes[result.ReadLink.ID]) {
		t.Fatalf("read link list = %d %s, want metadata without any credential", listed.Code, listed.Body)
	}
	for _, body := range []string{
		`{"startWeek":"2026-09-21","weekCount":0}`,
		`{"startWeek":"2026-09-21","weekCount":5}`,
		`{"startWeek":"2026-09-22","weekCount":1}`,
	} {
		invalid := managementRequest(handler, http.MethodPost,
			"/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"/read-links", previewToken, body)
		if invalid.Code != http.StatusBadRequest {
			t.Fatalf("create with %s status = %d, want %d", body, invalid.Code, http.StatusBadRequest)
		}
	}
}

func TestReadLinkAuthorizesEveryScheduleWeekAndMasksMedicalLeave(t *testing.T) {
	store := newReadLinkStoreStub()
	link := schedule.ReadLink{
		ID: "44444444-4444-4444-8444-444444444444", ScheduleID: store.target.Schedule.ID,
		StartWeek: "2026-09-21", WeekCount: 2,
	}
	const token = "read-token-with-more-than-thirty-two-characters"
	store.links[link.ID] = link
	store.readTokenHashes[link.ID] = hashManagementToken(token)
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	path := "/api/read-links/" + link.ID + "/schedules/" + link.ScheduleID + "/weeks/2026-09-21"
	response := managementRequest(handler, http.MethodGet, path, token, "")
	if response.Code != http.StatusOK {
		t.Fatalf("read scoped week status = %d, want %d; body=%s", response.Code, http.StatusOK, response.Body)
	}
	if strings.Contains(response.Body.String(), schedule.DayStateMedicalLeave) || strings.Contains(response.Body.String(), "patternState") || strings.Contains(response.Body.String(), "revision") {
		t.Fatalf("reader response exposed editor-only fields: %s", response.Body)
	}
	if !strings.Contains(response.Body.String(), `"state":"unavailable"`) || strings.Contains(response.Body.String(), token) {
		t.Fatalf("reader response did not safely project private data: %s", response.Body)
	}
	if !strings.Contains(response.Body.String(), `"startWeek":"2026-09-21"`) || !strings.Contains(response.Body.String(), `"weekCount":2`) {
		t.Fatalf("reader response omitted its stored fixed scope: %s", response.Body)
	}

	for _, request := range []struct {
		path  string
		token string
	}{
		{path: path},
		{path: path, token: "wrong-read-token-with-more-than-thirty-two-characters"},
		{path: "/api/read-links/" + link.ID + "/schedules/99999999-9999-4999-8999-999999999999/weeks/2026-09-21", token: token},
		{path: "/api/read-links/" + link.ID + "/schedules/" + link.ScheduleID + "/weeks/2026-10-05", token: token},
	} {
		denied := managementRequest(handler, http.MethodGet, request.path, request.token, "")
		if denied.Code != http.StatusUnauthorized || strings.Contains(denied.Body.String(), "Equipe privada") || strings.Contains(denied.Body.String(), token) {
			t.Fatalf("denied request %s = %d %s, want credential-safe 401", request.path, denied.Code, denied.Body)
		}
	}

	revoked := managementRequest(handler, http.MethodDelete,
		"/api/management-spaces/11111111-1111-4111-8111-111111111111/schedules/"+link.ScheduleID+"/read-links/"+link.ID,
		previewToken, "")
	if revoked.Code != http.StatusNoContent {
		t.Fatalf("revoke read link status = %d, want %d; body=%s", revoked.Code, http.StatusNoContent, revoked.Body)
	}
	deniedAfterRevoke := managementRequest(handler, http.MethodGet, path, token, "")
	if deniedAfterRevoke.Code != http.StatusUnauthorized || strings.Contains(deniedAfterRevoke.Body.String(), "Equipe privada") {
		t.Fatalf("request after revocation = %d %s, want credential-safe 401", deniedAfterRevoke.Code, deniedAfterRevoke.Body)
	}
	if got := deniedAfterRevoke.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("denial Cache-Control = %q, want no-store", got)
	}
}
