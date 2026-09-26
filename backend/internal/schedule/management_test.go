package schedule_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

type managementSpaceStore struct {
	mu                     sync.Mutex
	createdManagementSpace schedule.ManagementSpace
	createdSchedule        schedule.Schedule
	credentialHash         string
	createCalls            int
	createErr              error
	spaces                 map[string]schedule.ManagementSpaceView
	tokenHashes            map[string]string
}

func (store *managementSpaceStore) CreateManagementSpace(_ context.Context, space schedule.ManagementSpace, firstSchedule schedule.Schedule, tokenHash string) error {
	store.createdManagementSpace = space
	store.createdSchedule = firstSchedule
	store.credentialHash = tokenHash
	store.createCalls++
	if store.createErr != nil {
		return store.createErr
	}
	if store.spaces == nil {
		store.spaces = make(map[string]schedule.ManagementSpaceView)
		store.tokenHashes = make(map[string]string)
	}
	store.spaces[space.ID] = schedule.ManagementSpaceView{ManagementSpace: space, Schedules: []schedule.Schedule{firstSchedule}}
	store.tokenHashes[space.ID] = tokenHash
	return nil
}

func TestCreationPauseUsesObservedFreeQuotaThresholdsAndKeepsExistingSpaceAvailable(t *testing.T) {
	space := schedule.ManagementSpace{ID: "2e7b2b68-bc17-4f5d-9c50-4f6e4e290238", Name: "Clínica"}
	firstSchedule := schedule.Schedule{ID: "7dd21a89-9741-4a5e-8c6d-5e6ea23fce14", Name: "Semana", ManagementSpace: space}
	token := strings.Repeat("a", 43)
	store := &managementSpaceStore{
		spaces:      map[string]schedule.ManagementSpaceView{space.ID: {ManagementSpace: space, Schedules: []schedule.Schedule{firstSchedule}}},
		tokenHashes: map[string]string{space.ID: hashManagementToken(token)},
	}
	handler := schedule.NewHTTPHandlerWithManagement(
		&memoryScheduleStore{},
		store,
		"preview",
		previewOrigin,
		"",
		schedule.ManagementSecurity{
			CreationPaused: true,
			ChallengeVerifier: challengeVerifierFunc(func(context.Context, string, string, string) (bool, error) {
				t.Fatal("paused creation must stop before challenge verification")
				return false, nil
			}),
			CreationRateLimiter: creationRateLimiterFunc(func(context.Context, string) (bool, error) {
				t.Fatal("paused creation must stop before rate limiting")
				return false, nil
			}),
		},
	)

	paused := managementRequest(handler, http.MethodPost, "/api/management-spaces", "", `{"spaceName":"Novo","scheduleName":"Semana","turnstileToken":"proof"}`)
	if paused.Code != http.StatusServiceUnavailable || !strings.Contains(paused.Body.String(), `"error":"creation_paused"`) {
		t.Fatalf("POST while paused = %d %s, want a distinct creation_paused response", paused.Code, paused.Body)
	}
	if store.createCalls != 0 {
		t.Fatalf("creation store calls = %d, want 0 while paused", store.createCalls)
	}

	read := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+space.ID, token, "")
	if read.Code != http.StatusOK || !strings.Contains(read.Body.String(), space.ID) {
		t.Fatalf("existing Space GET while creation is paused = %d %s, want its current data", read.Code, read.Body)
	}
	rename := managementRequest(handler, http.MethodPatch, "/api/management-spaces/"+space.ID+"/schedules/"+firstSchedule.ID, token, `{"name":"Semana atualizada"}`)
	if rename.Code != http.StatusOK || !strings.Contains(rename.Body.String(), "Semana atualizada") {
		t.Fatalf("existing Space edit while creation is paused = %d %s, want a successful rename", rename.Code, rename.Body)
	}
}

func TestQuotaThresholdCrossingPausesSpaceCreation(t *testing.T) {
	store := &managementSpaceStore{}
	verifierCalls := 0
	limiterCalls := 0
	handler := schedule.NewHTTPHandlerWithManagement(
		&memoryScheduleStore{},
		store,
		"preview",
		previewOrigin,
		"",
		schedule.ManagementSecurity{
			QuotaMonitoringEnabled: true,
			QuotaMonitoringReady:   true,
			QuotaUsage:             schedule.FreeQuotaUsage{D1RowsWrittenPerDay: 80_000},
			ChallengeVerifier: challengeVerifierFunc(func(context.Context, string, string, string) (bool, error) {
				verifierCalls++
				return true, nil
			}),
			CreationRateLimiter: creationRateLimiterFunc(func(context.Context, string) (bool, error) {
				limiterCalls++
				return true, nil
			}),
		},
	)

	response := managementRequest(handler, http.MethodPost, "/api/management-spaces", "", `{"spaceName":"Novo","scheduleName":"Semana","turnstileToken":"proof"}`)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"error":"creation_paused"`) {
		t.Fatalf("POST at observed 80%% D1 write usage = %d %s, want creation_paused", response.Code, response.Body)
	}
	if verifierCalls != 0 || limiterCalls != 0 || store.createCalls != 0 {
		t.Fatalf("rate-limit, verification, and store calls = %d/%d/%d, want 0/0/0 after threshold crossing", limiterCalls, verifierCalls, store.createCalls)
	}
}

func TestSpaceCreationFailsClosedWhenQuotaSnapshotIsIncomplete(t *testing.T) {
	store := &managementSpaceStore{}
	handler := schedule.NewHTTPHandlerWithManagement(
		&memoryScheduleStore{},
		store,
		"preview",
		previewOrigin,
		"",
		schedule.ManagementSecurity{QuotaMonitoringEnabled: true},
	)
	response := managementRequest(handler, http.MethodPost, "/api/management-spaces", "", `{"spaceName":"Novo","scheduleName":"Semana","turnstileToken":"proof"}`)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"error":"creation_paused"`) {
		t.Fatalf("POST with incomplete quota measurements = %d %s, want creation_paused", response.Code, response.Body)
	}
	if store.createCalls != 0 {
		t.Fatalf("creation store calls = %d, want 0 until quota measurements are complete", store.createCalls)
	}
}

func TestSpaceCreationFailsClosedWhenQuotaSnapshotIsStale(t *testing.T) {
	store := &managementSpaceStore{}
	handler := schedule.NewHTTPHandlerWithManagement(
		&memoryScheduleStore{},
		store,
		"preview",
		previewOrigin,
		"",
		schedule.ManagementSecurity{QuotaMonitoringEnabled: true, QuotaMonitoringReady: false},
	)
	response := managementRequest(handler, http.MethodPost, "/api/management-spaces", "", `{"spaceName":"Novo","scheduleName":"Semana","turnstileToken":"proof"}`)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"error":"creation_paused"`) {
		t.Fatalf("POST with a stale quota snapshot = %d %s, want creation_paused", response.Code, response.Body)
	}
}

func TestD1QuotaErrorsHaveADistinctSanitizedCreationResponse(t *testing.T) {
	for _, detail := range []string{
		"D1_ERROR: Your account has exceeded D1's free tier daily row read limit.",
		"D1_ERROR: Your account has exceeded D1's free tier daily row write limit.",
		"D1_ERROR: Your account has exceeded D1's maximum account storage limit",
		"D1_ERROR: Exceeded maximum DB size.",
	} {
		t.Run(detail, func(t *testing.T) {
			store := &managementSpaceStore{createErr: errors.New(detail)}
			handler := schedule.NewHTTPHandlerWithManagement(
				&memoryScheduleStore{},
				store,
				"preview",
				previewOrigin,
				"",
				schedule.ManagementSecurity{
					ChallengeVerifier:   challengeVerifierFunc(func(context.Context, string, string, string) (bool, error) { return true, nil }),
					CreationRateLimiter: creationRateLimiterFunc(func(context.Context, string) (bool, error) { return true, nil }),
				},
			)
			request := httptest.NewRequest(http.MethodPost, "/api/management-spaces", strings.NewReader(`{"spaceName":"Sensitive clinic","scheduleName":"Sensitive schedule","turnstileToken":"secret-proof"}`))
			request.Header.Set("Origin", previewOrigin)
			request.Header.Set("CF-Connecting-IP", "198.51.100.42")
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"error":"platform_quota_exhausted"`) {
				t.Fatalf("POST after D1 quota error = %d %s, want a distinct platform_quota_exhausted response", response.Code, response.Body)
			}
			for _, sensitive := range []string{detail, "Sensitive clinic", "Sensitive schedule", "secret-proof", "198.51.100.42"} {
				if strings.Contains(response.Body.String(), sensitive) {
					t.Fatalf("quota error response exposed %q: %s", sensitive, response.Body)
				}
			}
		})
	}
}

func (store *managementSpaceStore) GetManagementSpace(_ context.Context, spaceID, tokenHash string) (schedule.ManagementSpaceView, error) {
	space, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ManagementSpaceView{}, schedule.ErrUnauthorized
	}
	return space, nil
}

func (store *managementSpaceStore) ReplaceManagementToken(_ context.Context, spaceID, currentTokenHash, nextTokenHash string) (bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if _, exists := store.spaces[spaceID]; !exists || store.tokenHashes[spaceID] != currentTokenHash {
		return false, nil
	}
	store.tokenHashes[spaceID] = nextTokenHash
	return true, nil
}

func (store *managementSpaceStore) RenameManagementSpace(_ context.Context, spaceID, tokenHash, name string) (schedule.ManagementSpace, error) {
	space, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ManagementSpace{}, schedule.ErrUnauthorized
	}
	space.ManagementSpace.Name = name
	for index := range space.Schedules {
		space.Schedules[index].ManagementSpace.Name = name
	}
	store.spaces[spaceID] = space
	return space.ManagementSpace, nil
}

func (store *managementSpaceStore) RenameManagementSchedule(_ context.Context, spaceID, scheduleID, tokenHash, name string) (schedule.Schedule, error) {
	space, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.Schedule{}, schedule.ErrUnauthorized
	}
	for index := range space.Schedules {
		if space.Schedules[index].ID == scheduleID {
			space.Schedules[index].Name = name
			store.spaces[spaceID] = space
			return space.Schedules[index], nil
		}
	}
	return schedule.Schedule{}, schedule.ErrNotFound
}

type challengeVerifierFunc func(context.Context, string, string, string) (bool, error)

func (verify challengeVerifierFunc) Verify(ctx context.Context, token, remoteIP, expectedHostname string) (bool, error) {
	return verify(ctx, token, remoteIP, expectedHostname)
}

type creationRateLimiterFunc func(context.Context, string) (bool, error)

func (limit creationRateLimiterFunc) Allow(ctx context.Context, key string) (bool, error) {
	return limit(ctx, key)
}

func TestManagementSpaceCanBeCreatedWithVerifiedChallenge(t *testing.T) {
	store := &managementSpaceStore{}
	verifierCalls := 0
	limiterCalls := 0
	handler := schedule.NewHTTPHandlerWithManagement(
		&memoryScheduleStore{},
		store,
		"preview",
		previewOrigin,
		"",
		schedule.ManagementSecurity{
			ChallengeVerifier: challengeVerifierFunc(func(_ context.Context, token, remoteIP, expectedHostname string) (bool, error) {
				verifierCalls++
				if token != "turnstile-proof" || remoteIP != "198.51.100.42" || expectedHostname != "preview.turnocerto.pages.dev" {
					t.Fatalf("challenge inputs = (%q, %q, %q), want the submitted proof, client IP, and configured hostname", token, remoteIP, expectedHostname)
				}
				return true, nil
			}),
			CreationRateLimiter: creationRateLimiterFunc(func(_ context.Context, key string) (bool, error) {
				limiterCalls++
				if len(key) != sha256.Size*2 {
					t.Fatalf("rate-limit key length = %d, want a hashed client identifier", len(key))
				}
				return true, nil
			}),
		},
	)

	request := httptest.NewRequest(http.MethodPost, "/api/management-spaces", strings.NewReader(`{"spaceName":"Clínica","scheduleName":"Semana","turnstileToken":"turnstile-proof"}`))
	request.Header.Set("Origin", previewOrigin)
	request.Header.Set("CF-Connecting-IP", "198.51.100.42")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("POST status = %d, want %d; body=%s", response.Code, http.StatusCreated, response.Body)
	}
	if store.createCalls != 1 || verifierCalls != 1 || limiterCalls != 1 {
		t.Fatalf("create/verifier/limiter calls = %d/%d/%d, want 1/1/1", store.createCalls, verifierCalls, limiterCalls)
	}
	if store.createdManagementSpace.Name != "Clínica" || store.createdSchedule.Name != "Semana" {
		t.Fatalf("created records = %#v and %#v, want submitted names", store.createdManagementSpace, store.createdSchedule)
	}
	if store.createdManagementSpace.ID == "" || store.createdSchedule.ID == "" || store.createdSchedule.ManagementSpace.ID != store.createdManagementSpace.ID {
		t.Fatalf("created IDs are not linked: %#v %#v", store.createdManagementSpace, store.createdSchedule)
	}

	var result struct {
		ManagementToken string `json:"managementToken"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode creation response: %v", err)
	}
	if len(result.ManagementToken) != 43 {
		t.Fatalf("returned management token length = %d, want 43 base64url characters", len(result.ManagementToken))
	}
	digest := sha256.Sum256([]byte(result.ManagementToken))
	if store.credentialHash != hex.EncodeToString(digest[:]) {
		t.Fatal("persisted credential is not the SHA-256 hash of the returned Management Link token")
	}
	if strings.Contains(response.Body.String(), store.credentialHash) {
		t.Fatal("creation response exposed the stored credential hash")
	}
	if got := response.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("Cache-Control = %q, want private no-store", got)
	}
}

func TestManagementLinkAuthorizesOnlyItsSpaceAndCanRenameTheFirstSchedule(t *testing.T) {
	store := &managementSpaceStore{
		spaces:      map[string]schedule.ManagementSpaceView{},
		tokenHashes: map[string]string{},
	}
	space := schedule.ManagementSpace{ID: "2e7b2b68-bc17-4f5d-9c50-4f6e4e290238", Name: "Clínica"}
	firstSchedule := schedule.Schedule{ID: "7dd21a89-9741-4a5e-8c6d-5e6ea23fce14", Name: "Semana", ManagementSpace: space}
	token := strings.Repeat("a", 43)
	store.spaces[space.ID] = schedule.ManagementSpaceView{ManagementSpace: space, Schedules: []schedule.Schedule{firstSchedule}}
	store.tokenHashes[space.ID] = hashManagementToken(token)
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})

	unauthorized := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+space.ID, "", "")
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("GET without a Management Link token status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}
	wrongCredential := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+space.ID, "wrong token", "")
	if wrongCredential.Code != http.StatusUnauthorized {
		t.Fatalf("GET with a wrong Management Link token status = %d, want %d", wrongCredential.Code, http.StatusUnauthorized)
	}
	if strings.Contains(wrongCredential.Body.String(), token) || strings.Contains(wrongCredential.Body.String(), "Clínica") {
		t.Fatal("unauthorized response exposed credential or Space data")
	}

	loaded := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+space.ID, token, "")
	if loaded.Code != http.StatusOK {
		t.Fatalf("GET with the matching Management Link token status = %d, want %d; body=%s", loaded.Code, http.StatusOK, loaded.Body)
	}
	var view schedule.ManagementSpaceView
	if err := json.Unmarshal(loaded.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode Management Space response: %v", err)
	}
	if view.ManagementSpace.ID != space.ID || len(view.Schedules) != 1 || view.Schedules[0].ID != firstSchedule.ID {
		t.Fatalf("GET returned %#v, want the authorized Space and its first Schedule", view)
	}

	renamed := managementRequest(handler, http.MethodPatch, "/api/management-spaces/"+space.ID+"/schedules/"+firstSchedule.ID, token, `{"name":"Plantão"}`)
	if renamed.Code != http.StatusOK {
		t.Fatalf("PATCH with the matching token status = %d, want %d; body=%s", renamed.Code, http.StatusOK, renamed.Body)
	}
	reloaded := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+space.ID, token, "")
	if reloaded.Code != http.StatusOK || !strings.Contains(reloaded.Body.String(), `"name":"Plantão"`) {
		t.Fatalf("GET after schedule rename = %d %s, want persisted new name", reloaded.Code, reloaded.Body)
	}

	wrongSchedule := managementRequest(handler, http.MethodPatch, "/api/management-spaces/"+space.ID+"/schedules/90ac6a4e-f314-47c5-913e-7312396c402a", token, `{"name":"Wrong Space"}`)
	if wrongSchedule.Code != http.StatusNotFound {
		t.Fatalf("PATCH for a Schedule outside the Space status = %d, want %d", wrongSchedule.Code, http.StatusNotFound)
	}
}

func TestManagementLinkCanRenameItsSpaceAndOnlyThatSpace(t *testing.T) {
	store := &managementSpaceStore{
		spaces:      map[string]schedule.ManagementSpaceView{},
		tokenHashes: map[string]string{},
	}
	space := schedule.ManagementSpace{ID: "2e7b2b68-bc17-4f5d-9c50-4f6e4e290238", Name: "Clínica"}
	firstSchedule := schedule.Schedule{ID: "7dd21a89-9741-4a5e-8c6d-5e6ea23fce14", Name: "Semana", ManagementSpace: space}
	token := strings.Repeat("a", 43)
	store.spaces[space.ID] = schedule.ManagementSpaceView{ManagementSpace: space, Schedules: []schedule.Schedule{firstSchedule}}
	store.tokenHashes[space.ID] = hashManagementToken(token)
	otherSpace := schedule.ManagementSpace{ID: "35c6453f-73bf-4d67-9c22-8e4b3b52c3fd", Name: "Outro Espaço"}
	otherToken := strings.Repeat("b", 43)
	store.spaces[otherSpace.ID] = schedule.ManagementSpaceView{ManagementSpace: otherSpace}
	store.tokenHashes[otherSpace.ID] = hashManagementToken(otherToken)
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	path := "/api/management-spaces/" + space.ID

	unauthorized := managementRequest(handler, http.MethodPatch, path, "", `{"name":"Sem autorização"}`)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("PATCH without a Management Link token status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}

	wrongScope := managementRequest(handler, http.MethodPatch, path, otherToken, `{"name":"Fora do escopo"}`)
	if wrongScope.Code != http.StatusUnauthorized || strings.Contains(wrongScope.Body.String(), otherToken) {
		t.Fatalf("PATCH with an unrelated Space credential = %d %s, want a redacted 401", wrongScope.Code, wrongScope.Body)
	}

	renamed := managementRequest(handler, http.MethodPatch, path, token, `{"name":"Clínica Aurora"}`)
	if renamed.Code != http.StatusOK || !strings.Contains(renamed.Body.String(), `"name":"Clínica Aurora"`) {
		t.Fatalf("PATCH with the matching token = %d %s, want the renamed Space", renamed.Code, renamed.Body)
	}
	reloaded := managementRequest(handler, http.MethodGet, path, token, "")
	if reloaded.Code != http.StatusOK || !strings.Contains(reloaded.Body.String(), `"name":"Clínica Aurora"`) {
		t.Fatalf("GET after Space rename = %d %s, want persisted name", reloaded.Code, reloaded.Body)
	}
}

func TestManagementLinkReplacementRevokesOldCredentialAndPreservesSpace(t *testing.T) {
	store := &managementSpaceStore{
		spaces:      map[string]schedule.ManagementSpaceView{},
		tokenHashes: map[string]string{},
	}
	space := schedule.ManagementSpace{ID: "2e7b2b68-bc17-4f5d-9c50-4f6e4e290238", Name: "Clínica"}
	firstSchedule := schedule.Schedule{ID: "7dd21a89-9741-4a5e-8c6d-5e6ea23fce14", Name: "Semana", ManagementSpace: space}
	oldToken := strings.Repeat("a", 43)
	otherSpace := schedule.ManagementSpace{ID: "35c6453f-73bf-4d67-9c22-8e4b3b52c3fd", Name: "Outro Espaço"}
	otherToken := strings.Repeat("b", 43)
	store.spaces[space.ID] = schedule.ManagementSpaceView{ManagementSpace: space, Schedules: []schedule.Schedule{firstSchedule}}
	store.tokenHashes[space.ID] = hashManagementToken(oldToken)
	store.spaces[otherSpace.ID] = schedule.ManagementSpaceView{ManagementSpace: otherSpace}
	store.tokenHashes[otherSpace.ID] = hashManagementToken(otherToken)
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	path := "/api/management-spaces/" + space.ID + "/management-link"

	wrongSpace := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+otherSpace.ID+"/management-link", oldToken, "")
	if wrongSpace.Code != http.StatusUnauthorized {
		t.Fatalf("POST for another Space with the current token = %d %s, want 401", wrongSpace.Code, wrongSpace.Body)
	}
	otherSpaceRead := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+otherSpace.ID, otherToken, "")
	if otherSpaceRead.Code != http.StatusOK {
		t.Fatalf("other Space's credential after denied replacement = %d %s, want 200", otherSpaceRead.Code, otherSpaceRead.Body)
	}

	rotated := managementRequest(handler, http.MethodPost, path, oldToken, "")
	if rotated.Code != http.StatusOK {
		t.Fatalf("POST with the current credential = %d %s, want 200", rotated.Code, rotated.Body)
	}
	var result struct {
		ManagementToken string `json:"managementToken"`
	}
	if err := json.Unmarshal(rotated.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode replacement response: %v", err)
	}
	if len(result.ManagementToken) != 43 || result.ManagementToken == oldToken {
		t.Fatalf("replacement token length/value is invalid: %q", result.ManagementToken)
	}
	if got, want := store.tokenHashes[space.ID], hashManagementToken(result.ManagementToken); got != want {
		t.Fatal("store must retain only the hash of the replacement token")
	}
	if strings.Contains(rotated.Body.String(), store.tokenHashes[space.ID]) {
		t.Fatal("replacement response exposed the stored token hash")
	}
	for _, header := range []struct{ name, want string }{
		{"Cache-Control", "no-store"},
		{"Referrer-Policy", "no-referrer"},
		{"X-Robots-Tag", "noindex"},
	} {
		if got := rotated.Header().Get(header.name); !strings.Contains(got, header.want) {
			t.Errorf("%s = %q, want it to contain %q", header.name, got, header.want)
		}
	}

	oldRead := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+space.ID, oldToken, "")
	if oldRead.Code != http.StatusUnauthorized {
		t.Errorf("old credential GET = %d, want 401", oldRead.Code)
	}
	oldWrite := managementRequest(handler, http.MethodPatch, "/api/management-spaces/"+space.ID+"/schedules/"+firstSchedule.ID, oldToken, `{"name":"Denied"}`)
	if oldWrite.Code != http.StatusUnauthorized {
		t.Errorf("old credential PATCH = %d, want 401", oldWrite.Code)
	}
	newRead := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+space.ID, result.ManagementToken, "")
	if newRead.Code != http.StatusOK || !strings.Contains(newRead.Body.String(), `"id":"`+firstSchedule.ID+`"`) {
		t.Fatalf("replacement credential GET = %d %s, want the unchanged Space and Schedule", newRead.Code, newRead.Body)
	}
	newWrite := managementRequest(handler, http.MethodPatch, "/api/management-spaces/"+space.ID+"/schedules/"+firstSchedule.ID, result.ManagementToken, `{"name":"Turno novo"}`)
	if newWrite.Code != http.StatusOK {
		t.Fatalf("replacement credential PATCH = %d %s, want 200", newWrite.Code, newWrite.Body)
	}
	oldAgain := managementRequest(handler, http.MethodPost, path, oldToken, "")
	if oldAgain.Code != http.StatusUnauthorized {
		t.Errorf("old credential replacement retry = %d, want 401", oldAgain.Code)
	}
}

func TestConcurrentManagementLinkReplacementHasOneWinner(t *testing.T) {
	store := &managementSpaceStore{
		spaces:      map[string]schedule.ManagementSpaceView{},
		tokenHashes: map[string]string{},
	}
	space := schedule.ManagementSpace{ID: "2e7b2b68-bc17-4f5d-9c50-4f6e4e290238", Name: "Clínica"}
	oldToken := strings.Repeat("a", 43)
	store.spaces[space.ID] = schedule.ManagementSpaceView{ManagementSpace: space}
	store.tokenHashes[space.ID] = hashManagementToken(oldToken)
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	path := "/api/management-spaces/" + space.ID + "/management-link"
	responses := make(chan *httptest.ResponseRecorder, 2)
	for range 2 {
		go func() { responses <- managementRequest(handler, http.MethodPost, path, oldToken, "") }()
	}

	statuses := map[int]int{}
	var winnerToken string
	for range 2 {
		response := <-responses
		statuses[response.Code]++
		if response.Code == http.StatusOK {
			var result struct {
				ManagementToken string `json:"managementToken"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatalf("decode winning replacement response: %v", err)
			}
			winnerToken = result.ManagementToken
		}
	}
	if statuses[http.StatusOK] != 1 || statuses[http.StatusUnauthorized] != 1 {
		t.Fatalf("concurrent replacement statuses = %#v, want one 200 and one 401", statuses)
	}
	if winnerToken == "" || store.tokenHashes[space.ID] != hashManagementToken(winnerToken) {
		t.Fatal("the sole winning credential must be the only credential retained by the store")
	}
}

func TestManagementCreationFailsClosedForRejectedChallengesAndRateLimits(t *testing.T) {
	for _, test := range []struct {
		name            string
		challengeToken  string
		challengeResult bool
		challengeError  error
		limitAllowed    bool
		limitError      error
		wantStatus      int
		wantError       string
		wantVerifyCalls int
	}{
		{
			name:            "invalid or expired token",
			challengeToken:  "sensitive-turnstile-token",
			limitAllowed:    true,
			wantStatus:      http.StatusBadRequest,
			wantError:       "challenge_failed",
			wantVerifyCalls: 1,
		},
		{
			name:            "missing token is submitted for server verification",
			limitAllowed:    true,
			wantStatus:      http.StatusBadRequest,
			wantError:       "challenge_failed",
			wantVerifyCalls: 1,
		},
		{
			name:            "verification service is unavailable",
			challengeToken:  "sensitive-turnstile-token",
			challengeError:  context.DeadlineExceeded,
			limitAllowed:    true,
			wantStatus:      http.StatusServiceUnavailable,
			wantError:       "challenge_unavailable",
			wantVerifyCalls: 1,
		},
		{
			name:           "rate limit is reached before challenge verification",
			challengeToken: "sensitive-turnstile-token",
			limitAllowed:   false,
			wantStatus:     http.StatusTooManyRequests,
			wantError:      "creation_rate_limited",
		},
		{
			name:           "rate limit service is unavailable",
			challengeToken: "sensitive-turnstile-token",
			limitError:     context.DeadlineExceeded,
			wantStatus:     http.StatusServiceUnavailable,
			wantError:      "temporarily_unavailable",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &managementSpaceStore{}
			verifyCalls := 0
			handler := schedule.NewHTTPHandlerWithManagement(
				&memoryScheduleStore{},
				store,
				"preview",
				previewOrigin,
				"",
				schedule.ManagementSecurity{
					ChallengeVerifier: challengeVerifierFunc(func(_ context.Context, token, remoteIP, _ string) (bool, error) {
						verifyCalls++
						if token != test.challengeToken || remoteIP != "198.51.100.42" {
							t.Fatalf("challenge inputs = (%q, %q), want (%q, client IP)", token, remoteIP, test.challengeToken)
						}
						return test.challengeResult, test.challengeError
					}),
					CreationRateLimiter: creationRateLimiterFunc(func(context.Context, string) (bool, error) {
						return test.limitAllowed, test.limitError
					}),
				},
			)

			request := httptest.NewRequest(http.MethodPost, "/api/management-spaces", strings.NewReader(`{"spaceName":"Clínica","scheduleName":"Semana","turnstileToken":"`+test.challengeToken+`"}`))
			request.Header.Set("Origin", previewOrigin)
			request.Header.Set("CF-Connecting-IP", "198.51.100.42")
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			if response.Code != test.wantStatus || !strings.Contains(response.Body.String(), test.wantError) {
				t.Fatalf("POST = %d %s, want %d with %q", response.Code, response.Body, test.wantStatus, test.wantError)
			}
			if verifyCalls != test.wantVerifyCalls || store.createCalls != 0 {
				t.Fatalf("verify/create calls = %d/%d, want %d/0", verifyCalls, store.createCalls, test.wantVerifyCalls)
			}
			if strings.Contains(response.Body.String(), "sensitive-turnstile-token") || strings.Contains(response.Body.String(), "198.51.100.42") {
				t.Fatal("creation error response exposed the challenge token or client IP")
			}
		})
	}
}

func managementRequest(handler http.Handler, method, path, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Origin", previewOrigin)
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func hashManagementToken(token string) string {
	digest := sha256.Sum256([]byte(token))
	return hex.EncodeToString(digest[:])
}
