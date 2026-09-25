package schedule_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

type memoryScheduleStore struct {
	schedule schedule.Schedule
	getCalls int
}

const previewOrigin = "https://preview.turnocerto.pages.dev"

var previewToken = strings.Repeat("a", 43)

func (store *memoryScheduleStore) GetSchedule(_ context.Context, id string) (schedule.Schedule, error) {
	store.getCalls++
	if id != store.schedule.ID {
		return schedule.Schedule{}, schedule.ErrNotFound
	}
	return store.schedule, nil
}

func (store *memoryScheduleStore) RenameSchedule(_ context.Context, id, name string) (schedule.Schedule, error) {
	if id != store.schedule.ID {
		return schedule.Schedule{}, schedule.ErrNotFound
	}
	store.schedule.Name = name
	return store.schedule, nil
}

func TestScheduleCanBeRenamedAndReadBack(t *testing.T) {
	store := &memoryScheduleStore{schedule: schedule.Schedule{
		ID:   schedule.PreviewScheduleID,
		Name: "Escala de demonstração",
		ManagementSpace: schedule.ManagementSpace{
			ID:   "preview-space",
			Name: "Espaço de demonstração",
		},
	}}
	handler := schedule.NewHTTPHandler(store, "preview", previewOrigin, hashToken(previewToken))

	initial := requestSchedule(t, handler, http.MethodGet, "", "")
	if initial.Code != http.StatusOK {
		t.Fatalf("initial GET status = %d, want %d", initial.Code, http.StatusOK)
	}
	if got := decodeSchedule(t, initial).Name; got != "Escala de demonstração" {
		t.Fatalf("initial schedule name = %q", got)
	}

	renamed := requestSchedule(t, handler, http.MethodPatch, `{"name":"Plantão de sábado"}`, "application/json")
	if renamed.Code != http.StatusOK {
		t.Fatalf("PATCH status = %d, want %d; body=%s", renamed.Code, http.StatusOK, renamed.Body)
	}
	if got := decodeSchedule(t, renamed).Name; got != "Plantão de sábado" {
		t.Fatalf("renamed response name = %q", got)
	}
	if got := renamed.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("PATCH Cache-Control = %q, want private no-store", got)
	}
	if got := renamed.Header().Get("X-Robots-Tag"); !strings.Contains(got, "noindex") {
		t.Fatalf("PATCH X-Robots-Tag = %q, want noindex", got)
	}

	reloaded := requestSchedule(t, handler, http.MethodGet, "", "")
	if got := decodeSchedule(t, reloaded).Name; got != "Plantão de sábado" {
		t.Fatalf("name after a separate GET = %q, want persisted value", got)
	}
	if got := reloaded.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want private no-store", got)
	}
	if got := reloaded.Header().Get("X-Robots-Tag"); !strings.Contains(got, "noindex") {
		t.Fatalf("X-Robots-Tag = %q, want noindex", got)
	}
	if got := reloaded.Header().Get("Access-Control-Allow-Origin"); got != previewOrigin {
		t.Fatalf("Access-Control-Allow-Origin = %q, want configured preview origin", got)
	}
}

func TestPreviewScheduleFailsClosedWhenTokenIsNotConfigured(t *testing.T) {
	store := &memoryScheduleStore{schedule: schedule.Schedule{ID: schedule.PreviewScheduleID, Name: "Demo"}}
	handler := schedule.NewHTTPHandler(store, "preview", previewOrigin, "")
	response := requestSchedule(t, handler, http.MethodGet, "", "")

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("GET status without configured preview token = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if !strings.Contains(response.Body.String(), "temporarily_unavailable") {
		t.Fatalf("GET body without configured preview token = %s, want generic unavailable error", response.Body)
	}
}

func TestPreviewScheduleRequiresCorrectBearerToken(t *testing.T) {
	store := &memoryScheduleStore{schedule: schedule.Schedule{ID: schedule.PreviewScheduleID, Name: "Demo"}}
	handler := schedule.NewHTTPHandler(store, "preview", previewOrigin, hashToken(previewToken))
	for _, test := range []struct {
		name  string
		token string
	}{
		{name: "missing token"},
		{name: "short token", token: "wrong-token"},
		{name: "wrong token", token: strings.Repeat("b", 43)},
		{name: "oversized token", token: strings.Repeat("b", 4096)},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := requestScheduleWithToken(t, handler, http.MethodGet, "", "", test.token)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("GET status = %d, want %d; body=%s", response.Code, http.StatusUnauthorized, response.Body)
			}
			if !strings.Contains(response.Body.String(), `"error":"unauthorized"`) {
				t.Fatalf("GET body = %s, want a generic authorization error", response.Body)
			}
		})
	}
	if store.getCalls != 0 {
		t.Fatalf("unauthorized requests reached the store %d times, want 0", store.getCalls)
	}

	authorized := requestScheduleWithToken(t, handler, http.MethodGet, "", "", previewToken)
	if authorized.Code != http.StatusOK {
		t.Fatalf("GET with valid token status = %d, want %d; body=%s", authorized.Code, http.StatusOK, authorized.Body)
	}
}

func TestScheduleRenameRejectsNameOverEightyCharacters(t *testing.T) {
	store := &memoryScheduleStore{schedule: schedule.Schedule{ID: schedule.PreviewScheduleID, Name: "Before"}}
	handler := schedule.NewHTTPHandler(store, "preview", previewOrigin, hashToken(previewToken))
	tooLong := strings.Repeat("a", 81)
	body, err := json.Marshal(struct {
		Name string `json:"name"`
	}{Name: tooLong})
	if err != nil {
		t.Fatal(err)
	}

	response := requestSchedule(t, handler, http.MethodPatch, string(body), "application/json")
	if response.Code != http.StatusBadRequest {
		t.Fatalf("PATCH status = %d, want %d", response.Code, http.StatusBadRequest)
	}
	if store.schedule.Name != "Before" {
		t.Fatalf("invalid name changed the stored schedule to %q", store.schedule.Name)
	}
}

func TestScheduleFixtureIsUnavailableOutsidePreview(t *testing.T) {
	store := &memoryScheduleStore{schedule: schedule.Schedule{ID: schedule.PreviewScheduleID, Name: "Demo"}}
	handler := schedule.NewHTTPHandler(store, "production", previewOrigin, "")
	response := requestSchedule(t, handler, http.MethodGet, "", "")

	if response.Code != http.StatusNotFound {
		t.Fatalf("GET status = %d, want %d", response.Code, http.StatusNotFound)
	}
	if store.schedule.ID != schedule.PreviewScheduleID {
		t.Fatal(errors.New("production guard unexpectedly changed fixture"))
	}
}

func TestPreflightAllowsOnlyConfiguredWebOrigin(t *testing.T) {
	store := &memoryScheduleStore{schedule: schedule.Schedule{ID: schedule.PreviewScheduleID, Name: "Demo"}}
	handler := schedule.NewHTTPHandler(store, "preview", previewOrigin, hashToken(previewToken))

	allowed := httptest.NewRequest(http.MethodOptions, "/api/schedules/"+schedule.PreviewScheduleID, nil)
	allowed.Header.Set("Origin", previewOrigin)
	allowedResponse := httptest.NewRecorder()
	handler.ServeHTTP(allowedResponse, allowed)
	if allowedResponse.Code != http.StatusNoContent {
		t.Fatalf("allowed preflight status = %d, want %d", allowedResponse.Code, http.StatusNoContent)
	}
	if got := allowedResponse.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") {
		t.Fatalf("allowed headers = %q, want Authorization", got)
	}

	blocked := httptest.NewRequest(http.MethodOptions, "/api/schedules/"+schedule.PreviewScheduleID, nil)
	blocked.Header.Set("Origin", "https://untrusted.example")
	blockedResponse := httptest.NewRecorder()
	handler.ServeHTTP(blockedResponse, blocked)
	if blockedResponse.Code != http.StatusForbidden {
		t.Fatalf("untrusted preflight status = %d, want %d", blockedResponse.Code, http.StatusForbidden)
	}
	if got := blockedResponse.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("untrusted origin was granted CORS access: %q", got)
	}
}

func requestSchedule(t *testing.T, handler http.Handler, method, body, contentType string) *httptest.ResponseRecorder {
	return requestScheduleWithToken(t, handler, method, body, contentType, previewToken)
}

func requestScheduleWithToken(t *testing.T, handler http.Handler, method, body, contentType, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, "/api/schedules/"+schedule.PreviewScheduleID, bytes.NewBufferString(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("Origin", previewOrigin)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func hashToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}

func decodeSchedule(t *testing.T, response *httptest.ResponseRecorder) schedule.Schedule {
	t.Helper()
	var payload struct {
		Schedule schedule.Schedule `json:"schedule"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode response: %v; body=%s", err, response.Body)
	}
	return payload.Schedule
}
