package schedule_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

const (
	deletionSpaceID       = "11111111-1111-4111-8111-111111111111"
	otherDeletionSpaceID  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	deletionScheduleID    = "22222222-2222-4222-8222-222222222222"
	otherDeletionSchedule = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
)

type deletionManagementStore struct {
	*managementSpaceStore
	deleteScheduleCalls int
	deleteSpaceCalls    int
	deleteScheduleErr   error
	deleteSpaceErr      error
}

func (store *deletionManagementStore) DeleteManagementSchedule(_ context.Context, spaceID, scheduleID, tokenHash string) error {
	store.deleteScheduleCalls++
	if store.deleteScheduleErr != nil {
		return store.deleteScheduleErr
	}
	space, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ErrUnauthorized
	}
	for index, calendar := range space.Schedules {
		if calendar.ID == scheduleID {
			space.Schedules = append(space.Schedules[:index], space.Schedules[index+1:]...)
			store.spaces[spaceID] = space
			return nil
		}
	}
	return schedule.ErrNotFound
}

func (store *deletionManagementStore) DeleteManagementSpace(_ context.Context, spaceID, tokenHash string) error {
	store.deleteSpaceCalls++
	if store.deleteSpaceErr != nil {
		return store.deleteSpaceErr
	}
	if !store.hasSpaceToken(spaceID, tokenHash) {
		return schedule.ErrUnauthorized
	}
	delete(store.spaces, spaceID)
	delete(store.tokenHashes, spaceID)
	return nil
}

func (store *deletionManagementStore) hasSpaceToken(spaceID, tokenHash string) bool {
	return store.spaces[spaceID].ManagementSpace.ID != "" && store.tokenHashes[spaceID] == tokenHash
}

type deletionRecordStore struct {
	records map[string]schedule.DeletionRecord
	calls   int
	err     error
}

func (store *deletionRecordStore) RecordDeletion(_ context.Context, record schedule.DeletionRecord) error {
	store.calls++
	if store.err != nil {
		return store.err
	}
	if store.records == nil {
		store.records = make(map[string]schedule.DeletionRecord)
	}
	key := string(record.Scope) + ":" + record.SpaceID + ":" + record.ScheduleID
	store.records[key] = record
	return nil
}

func newDeletionTestStores() (*deletionManagementStore, *deletionRecordStore) {
	space := schedule.ManagementSpace{ID: deletionSpaceID, Name: "Clínica Aurora"}
	first := schedule.Schedule{ID: deletionScheduleID, Name: "Equipe da manhã", TimeZone: "America/Sao_Paulo", ManagementSpace: space}
	second := schedule.Schedule{ID: otherDeletionSchedule, Name: "Equipe da tarde", TimeZone: "America/Sao_Paulo", ManagementSpace: space}
	otherSpace := schedule.ManagementSpace{ID: otherDeletionSpaceID, Name: "Clínica Horizonte"}
	otherCalendar := schedule.Schedule{ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", Name: "Outra equipe", TimeZone: "America/Sao_Paulo", ManagementSpace: otherSpace}
	management := &deletionManagementStore{managementSpaceStore: &managementSpaceStore{
		spaces: map[string]schedule.ManagementSpaceView{
			space.ID:      {ManagementSpace: space, Schedules: []schedule.Schedule{first, second}, People: []schedule.Person{{ID: "person-1", Name: "Ana"}}},
			otherSpace.ID: {ManagementSpace: otherSpace, Schedules: []schedule.Schedule{otherCalendar}},
		},
		tokenHashes: map[string]string{
			space.ID:      hashManagementToken(previewToken),
			otherSpace.ID: hashManagementToken(strings.Repeat("b", 43)),
		},
	}}
	return management, &deletionRecordStore{}
}

func newDeletionHandler(management *deletionManagementStore, records *deletionRecordStore) http.Handler {
	return schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, management, "preview", previewOrigin, "", schedule.ManagementSecurity{}, records)
}

func confirmedDeletionRequest(handler http.Handler, method, path, token string) *httptest.ResponseRecorder {
	return managementRequest(handler, method, path, token, `{"confirmed":true}`)
}

func TestScheduleDeletionRequiresCurrentManagementLinkAndExplicitConfirmation(t *testing.T) {
	management, records := newDeletionTestStores()
	handler := newDeletionHandler(management, records)
	path := "/api/management-spaces/" + deletionSpaceID + "/schedules/" + deletionScheduleID

	unauthorized := confirmedDeletionRequest(handler, http.MethodDelete, path, "")
	if unauthorized.Code != http.StatusUnauthorized || records.calls != 0 || management.deleteScheduleCalls != 0 {
		t.Fatalf("unauthorized schedule deletion = %d, ledger calls %d, app deletes %d; want 401 and no writes", unauthorized.Code, records.calls, management.deleteScheduleCalls)
	}

	unconfirmed := managementRequest(handler, http.MethodDelete, path, previewToken, `{}`)
	if unconfirmed.Code != http.StatusBadRequest || records.calls != 0 || management.deleteScheduleCalls != 0 {
		t.Fatalf("unconfirmed schedule deletion = %d, ledger calls %d, app deletes %d; want 400 and no writes", unconfirmed.Code, records.calls, management.deleteScheduleCalls)
	}
}

func TestSpaceDeletionRequiresCurrentManagementLinkAndExplicitConfirmation(t *testing.T) {
	management, records := newDeletionTestStores()
	handler := newDeletionHandler(management, records)
	path := "/api/management-spaces/" + deletionSpaceID

	unauthorized := confirmedDeletionRequest(handler, http.MethodDelete, path, "")
	if unauthorized.Code != http.StatusUnauthorized || records.calls != 0 || management.deleteSpaceCalls != 0 {
		t.Fatalf("unauthorized Space deletion = %d, ledger calls %d, app deletes %d; want 401 and no writes", unauthorized.Code, records.calls, management.deleteSpaceCalls)
	}

	unconfirmed := managementRequest(handler, http.MethodDelete, path, previewToken, `{}`)
	if unconfirmed.Code != http.StatusBadRequest || records.calls != 0 || management.deleteSpaceCalls != 0 {
		t.Fatalf("unconfirmed Space deletion = %d, ledger calls %d, app deletes %d; want 400 and no writes", unconfirmed.Code, records.calls, management.deleteSpaceCalls)
	}
}

func TestWrongSpaceCannotDeleteAnotherSpacesSchedule(t *testing.T) {
	management, records := newDeletionTestStores()
	handler := newDeletionHandler(management, records)
	path := "/api/management-spaces/" + otherDeletionSpaceID + "/schedules/cccccccc-cccc-4ccc-8ccc-cccccccccccc"

	response := confirmedDeletionRequest(handler, http.MethodDelete, path, previewToken)
	if response.Code != http.StatusUnauthorized && response.Code != http.StatusNotFound {
		t.Fatalf("wrong-Space deletion status = %d, want a non-disclosing denial", response.Code)
	}
	if records.calls != 0 || management.deleteScheduleCalls != 0 {
		t.Fatalf("wrong-Space deletion wrote ledger %d times and application rows %d times", records.calls, management.deleteScheduleCalls)
	}
}

func TestScheduleDeletionRecordsMinimalIntentBeforeRemovingOnlyThatSchedule(t *testing.T) {
	management, records := newDeletionTestStores()
	handler := newDeletionHandler(management, records)
	path := "/api/management-spaces/" + deletionSpaceID + "/schedules/" + deletionScheduleID

	response := confirmedDeletionRequest(handler, http.MethodDelete, path, previewToken)
	if response.Code != http.StatusNoContent {
		t.Fatalf("DELETE schedule status = %d, body=%s; want 204", response.Code, response.Body)
	}
	if len(records.records) != 1 {
		t.Fatalf("deletion records = %d, want one", len(records.records))
	}
	for _, record := range records.records {
		if record.Scope != schedule.DeletionScopeSchedule || record.SpaceID != deletionSpaceID || record.ScheduleID != deletionScheduleID {
			t.Fatalf("record = %#v, want only schedule and Space identifiers", record)
		}
	}
	view, err := management.GetManagementSpace(context.Background(), deletionSpaceID, hashManagementToken(previewToken))
	if err != nil || len(view.Schedules) != 1 || view.Schedules[0].ID != otherDeletionSchedule || len(view.People) != 1 {
		t.Fatalf("remaining Space after deleting one schedule = %#v, %v; want other schedule and shared Person to remain", view, err)
	}

	repeated := confirmedDeletionRequest(handler, http.MethodDelete, path, previewToken)
	if repeated.Code != http.StatusNotFound || len(records.records) != 1 || records.calls != 1 || management.deleteScheduleCalls != 1 {
		t.Fatalf("repeat deletion = %d, records=%d, ledger calls=%d, app deletes=%d; want an opaque no-op without another record", repeated.Code, len(records.records), records.calls, management.deleteScheduleCalls)
	}
}

func TestExternalDeletionRecordFailureNeverReportsDeletionOrRemovesLiveData(t *testing.T) {
	management, records := newDeletionTestStores()
	records.err = errors.New("external D1 unavailable: sensitive provider detail")
	handler := newDeletionHandler(management, records)
	path := "/api/management-spaces/" + deletionSpaceID + "/schedules/" + deletionScheduleID

	response := confirmedDeletionRequest(handler, http.MethodDelete, path, previewToken)
	if response.Code != http.StatusServiceUnavailable || strings.Contains(response.Body.String(), "sensitive provider detail") {
		t.Fatalf("DELETE after ledger failure = %d %s; want sanitized 503", response.Code, response.Body)
	}
	if management.deleteScheduleCalls != 0 {
		t.Fatalf("application deletion calls = %d, want none before a successful external record", management.deleteScheduleCalls)
	}
	view, err := management.GetManagementSpace(context.Background(), deletionSpaceID, hashManagementToken(previewToken))
	if err != nil || len(view.Schedules) != 2 {
		t.Fatalf("live schedules after ledger failure = %#v, %v; want both schedules intact", view.Schedules, err)
	}
}

func TestActiveDeletionFailureReturnsNonSuccessAndRetryReusesTheExternalRecord(t *testing.T) {
	management, records := newDeletionTestStores()
	management.deleteScheduleErr = errors.New("application database unavailable: sensitive provider detail")
	handler := newDeletionHandler(management, records)
	path := "/api/management-spaces/" + deletionSpaceID + "/schedules/" + deletionScheduleID

	failed := confirmedDeletionRequest(handler, http.MethodDelete, path, previewToken)
	if failed.Code != http.StatusServiceUnavailable || strings.Contains(failed.Body.String(), "sensitive provider detail") {
		t.Fatalf("DELETE after ledger commit = %d %s; want sanitized 503", failed.Code, failed.Body)
	}
	if len(records.records) != 1 || records.calls != 1 {
		t.Fatalf("records after active-data failure = %d, ledger calls=%d; want one durable intent", len(records.records), records.calls)
	}
	view, err := management.GetManagementSpace(context.Background(), deletionSpaceID, hashManagementToken(previewToken))
	if err != nil || len(view.Schedules) != 2 {
		t.Fatalf("live schedules after active-data failure = %#v, %v; want both schedules intact", view.Schedules, err)
	}

	management.deleteScheduleErr = nil
	retried := confirmedDeletionRequest(handler, http.MethodDelete, path, previewToken)
	if retried.Code != http.StatusNoContent || len(records.records) != 1 || records.calls != 2 {
		t.Fatalf("retry = %d, records=%d, ledger calls=%d; want 204 with the same deduplicated record", retried.Code, len(records.records), records.calls)
	}
	view, err = management.GetManagementSpace(context.Background(), deletionSpaceID, hashManagementToken(previewToken))
	if err != nil || len(view.Schedules) != 1 || view.Schedules[0].ID != otherDeletionSchedule {
		t.Fatalf("Space after retry = %#v, %v; want only the unrelated schedule", view, err)
	}
}

func TestSpaceDeletionInvalidatesManagementLinkAndRepeatIsNonDisclosing(t *testing.T) {
	management, records := newDeletionTestStores()
	handler := newDeletionHandler(management, records)
	path := "/api/management-spaces/" + deletionSpaceID

	response := confirmedDeletionRequest(handler, http.MethodDelete, path, previewToken)
	if response.Code != http.StatusNoContent || len(records.records) != 1 {
		t.Fatalf("DELETE Space = %d %s, records=%d; want 204 and one external record", response.Code, response.Body, len(records.records))
	}
	for _, record := range records.records {
		if record.Scope != schedule.DeletionScopeManagementSpace || record.SpaceID != deletionSpaceID || record.ScheduleID != "" {
			t.Fatalf("space deletion record = %#v, want only Space identifier and deletion scope", record)
		}
	}
	read := managementRequest(handler, http.MethodGet, path, previewToken, "")
	if read.Code != http.StatusUnauthorized && read.Code != http.StatusNotFound {
		t.Fatalf("old Management Link GET = %d, want a non-disclosing denial", read.Code)
	}
	if _, exists := management.spaces[otherDeletionSpaceID]; !exists {
		t.Fatal("deleting one Space removed a different Space")
	}
	if len(management.spaces) != 1 {
		t.Fatalf("remaining Spaces = %d, want only the unrelated Space", len(management.spaces))
	}

	repeated := confirmedDeletionRequest(handler, http.MethodDelete, path, previewToken)
	if repeated.Code != http.StatusUnauthorized && repeated.Code != http.StatusNotFound {
		t.Fatalf("repeat Space deletion = %d, want a non-disclosing denial", repeated.Code)
	}
	if len(records.records) != 1 || records.calls != 1 || management.deleteSpaceCalls != 1 {
		t.Fatalf("repeat Space deletion changed state: records=%d, ledger calls=%d, app deletes=%d", len(records.records), records.calls, management.deleteSpaceCalls)
	}
}
