package schedule_test

import (
	"bytes"
	"context"
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
}

const previewOrigin = "https://preview.turnocerto.pages.dev"

func (store *memoryScheduleStore) GetSchedule(_ context.Context, id string) (schedule.Schedule, error) {
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
	handler := schedule.NewHTTPHandler(store, "preview", previewOrigin)

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

func TestScheduleRenameRejectsNameOverEightyCharacters(t *testing.T) {
	store := &memoryScheduleStore{schedule: schedule.Schedule{ID: schedule.PreviewScheduleID, Name: "Before"}}
	handler := schedule.NewHTTPHandler(store, "preview", previewOrigin)
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
	handler := schedule.NewHTTPHandler(store, "production", previewOrigin)
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
	handler := schedule.NewHTTPHandler(store, "preview", previewOrigin)

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
	t.Helper()
	request := httptest.NewRequest(method, "/api/schedules/"+schedule.PreviewScheduleID, bytes.NewBufferString(body))
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	request.Header.Set("Origin", previewOrigin)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
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
