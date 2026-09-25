package schedule_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

type schedulingManagementSpaceStore struct {
	*managementSpaceStore
}

func newSchedulingManagementSpaceStore() *schedulingManagementSpaceStore {
	store := &schedulingManagementSpaceStore{managementSpaceStore: &managementSpaceStore{}}
	space := schedule.ManagementSpace{ID: "11111111-1111-4111-8111-111111111111", Name: "Clínica Aurora"}
	calendar := schedule.Schedule{ID: "22222222-2222-4222-8222-222222222222", Name: "Equipe da manhã", TimeZone: "America/Sao_Paulo", ManagementSpace: space}
	store.spaces = map[string]schedule.ManagementSpaceView{
		space.ID: {ManagementSpace: space, Schedules: []schedule.Schedule{calendar}, People: []schedule.Person{}},
	}
	store.tokenHashes = map[string]string{space.ID: hashManagementToken(previewToken)}
	return store
}

func (store *schedulingManagementSpaceStore) GetManagementSpace(_ context.Context, spaceID, tokenHash string) (schedule.ManagementSpaceView, error) {
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ManagementSpaceView{}, schedule.ErrUnauthorized
	}
	return view, nil
}

func (store *schedulingManagementSpaceStore) CreateSchedule(_ context.Context, spaceID, tokenHash string, calendar schedule.Schedule) error {
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ErrUnauthorized
	}
	calendar.ManagementSpace = view.ManagementSpace
	view.Schedules = append(view.Schedules, calendar)
	store.spaces[spaceID] = view
	return nil
}

func (store *schedulingManagementSpaceStore) CreatePerson(_ context.Context, spaceID, tokenHash string, person schedule.Person) error {
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ErrUnauthorized
	}
	view.People = append(view.People, person)
	store.spaces[spaceID] = view
	return nil
}

func (store *schedulingManagementSpaceStore) UpdateScheduleTimeZone(_ context.Context, spaceID, scheduleID, tokenHash, timeZone string) (schedule.Schedule, error) {
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.Schedule{}, schedule.ErrUnauthorized
	}
	for index, calendar := range view.Schedules {
		if calendar.ID == scheduleID {
			view.Schedules[index].TimeZone = timeZone
			store.spaces[spaceID] = view
			return view.Schedules[index], nil
		}
	}
	return schedule.Schedule{}, schedule.ErrNotFound
}

func (store *schedulingManagementSpaceStore) CreateParticipation(_ context.Context, spaceID, scheduleID, tokenHash string, participation schedule.WeekParticipation) error {
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ErrUnauthorized
	}
	for _, person := range view.People {
		if person.ID == participation.Person.ID {
			participation.Person = person
			for index, calendar := range view.Schedules {
				if calendar.ID == scheduleID {
					calendar.Participations = append(calendar.Participations, participation)
					view.Schedules[index] = calendar
					store.spaces[spaceID] = view
					return nil
				}
			}
			return schedule.ErrNotFound
		}
	}
	return schedule.ErrNotFound
}

func (store *schedulingManagementSpaceStore) CreateWeeklyPattern(_ context.Context, spaceID, scheduleID, participationID, tokenHash string, pattern schedule.WeeklyPattern) error {
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ErrUnauthorized
	}
	for scheduleIndex, calendar := range view.Schedules {
		if calendar.ID != scheduleID {
			continue
		}
		for participationIndex, participation := range calendar.Participations {
			if participation.ID == participationID {
				participation.PatternVersions = append(participation.PatternVersions, pattern)
				calendar.Participations[participationIndex] = participation
				view.Schedules[scheduleIndex] = calendar
				store.spaces[spaceID] = view
				return nil
			}
		}
	}
	return schedule.ErrNotFound
}

func (store *schedulingManagementSpaceStore) CreateDateException(_ context.Context, spaceID, scheduleID, participationID, tokenHash string, exception schedule.DateException) error {
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ErrUnauthorized
	}
	for scheduleIndex, calendar := range view.Schedules {
		if calendar.ID != scheduleID {
			continue
		}
		for participationIndex, participation := range calendar.Participations {
			if participation.ID != participationID {
				continue
			}
			for index := range participation.DateExceptions {
				if participation.DateExceptions[index].Date == exception.Date {
					participation.DateExceptions[index] = exception
					calendar.Participations[participationIndex] = participation
					view.Schedules[scheduleIndex] = calendar
					store.spaces[spaceID] = view
					return nil
				}
			}
			participation.DateExceptions = append(participation.DateExceptions, exception)
			calendar.Participations[participationIndex] = participation
			view.Schedules[scheduleIndex] = calendar
			store.spaces[spaceID] = view
			return nil
		}
		return schedule.ErrNotFound
	}
	return schedule.ErrNotFound
}

func TestManagementEditorCanCreateAndUpdateDateSpecificSpecialState(t *testing.T) {
	store := newSchedulingManagementSpaceStore()
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	spaceID := "11111111-1111-4111-8111-111111111111"
	scheduleID := "22222222-2222-4222-8222-222222222222"
	personResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/people", previewToken, `{"name":"Ana"}`)
	var personResult struct {
		Person schedule.Person `json:"person"`
	}
	if err := json.Unmarshal(personResponse.Body.Bytes(), &personResult); err != nil {
		t.Fatal(err)
	}
	participationBody := `{"personId":"` + personResult.Person.ID + `","startDate":"2026-09-07","endDate":"2026-09-13","pattern":{"effectiveFrom":"2026-09-07","weekdays":[{"weekday":1,"state":"day_off"},{"weekday":2,"state":"day_off"},{"weekday":3,"state":"day_off"},{"weekday":4,"state":"day_off"},{"weekday":5,"state":"day_off"},{"weekday":6,"state":"day_off"},{"weekday":7,"state":"day_off"}]}}`
	participationResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"/participations", previewToken, participationBody)
	var participationResult struct {
		Participation schedule.WeekParticipation `json:"participation"`
	}
	if err := json.Unmarshal(participationResponse.Body.Bytes(), &participationResult); err != nil {
		t.Fatal(err)
	}
	path := "/api/management-spaces/" + spaceID + "/schedules/" + scheduleID + "/participations/" + participationResult.Participation.ID + "/exceptions"
	outsideParticipation := managementRequest(handler, http.MethodPost, path, previewToken, `{"date":"2026-09-14","state":"vacation"}`)
	if outsideParticipation.Code != http.StatusBadRequest {
		t.Fatalf("out-of-range date exception status = %d, want %d", outsideParticipation.Code, http.StatusBadRequest)
	}
	exceptionResponse := managementRequest(handler, http.MethodPost, path, previewToken, `{"date":"2026-09-11","state":"vacation"}`)
	if exceptionResponse.Code != http.StatusCreated {
		t.Fatalf("create date exception status = %d, want %d; body=%s", exceptionResponse.Code, http.StatusCreated, exceptionResponse.Body)
	}
	updateResponse := managementRequest(handler, http.MethodPost, path, previewToken, `{"date":"2026-09-11","state":"absence"}`)
	if updateResponse.Code != http.StatusCreated {
		t.Fatalf("update date exception status = %d, want %d; body=%s", updateResponse.Code, http.StatusCreated, updateResponse.Body)
	}
	weekResponse := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"?weekStart=2026-09-07", previewToken, "")
	if weekResponse.Code != http.StatusOK {
		t.Fatalf("open week with exception status = %d, want %d; body=%s", weekResponse.Code, http.StatusOK, weekResponse.Body)
	}
	var weekResult struct {
		Week schedule.ScheduleWeek `json:"week"`
	}
	if err := json.Unmarshal(weekResponse.Body.Bytes(), &weekResult); err != nil {
		t.Fatal(err)
	}
	if got := weekResult.Week.People[0].Days[4].State; got != schedule.DayStateAbsence {
		t.Fatalf("Friday derived state after updating exception = %q, want absence", got)
	}
}

func TestManagementEditorCanShareOnePersonAcrossOverlappingSchedules(t *testing.T) {
	store := newSchedulingManagementSpaceStore()
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	spaceID := "11111111-1111-4111-8111-111111111111"
	initialScheduleID := "22222222-2222-4222-8222-222222222222"

	personResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/people", previewToken, `{"name":"Ana Ribeiro"}`)
	if personResponse.Code != http.StatusCreated {
		t.Fatalf("create person status = %d, want %d; body=%s", personResponse.Code, http.StatusCreated, personResponse.Body)
	}
	var personResult struct {
		Person schedule.Person `json:"person"`
	}
	if err := json.Unmarshal(personResponse.Body.Bytes(), &personResult); err != nil {
		t.Fatalf("decode person response: %v", err)
	}

	scheduleResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules", previewToken, `{"name":"Equipe da tarde","timeZone":"America/Los_Angeles"}`)
	if scheduleResponse.Code != http.StatusCreated {
		t.Fatalf("create schedule status = %d, want %d; body=%s", scheduleResponse.Code, http.StatusCreated, scheduleResponse.Body)
	}
	var scheduleResult struct {
		Schedule schedule.Schedule `json:"schedule"`
	}
	if err := json.Unmarshal(scheduleResponse.Body.Bytes(), &scheduleResult); err != nil {
		t.Fatalf("decode schedule response: %v", err)
	}
	if scheduleResult.Schedule.TimeZone != "America/Los_Angeles" {
		t.Fatalf("created schedule time zone = %q, want America/Los_Angeles", scheduleResult.Schedule.TimeZone)
	}

	pattern := func(effectiveFrom, mondayState, thursdayState string) string {
		days := make([]schedule.PatternDay, 7)
		for weekday := 1; weekday <= 7; weekday++ {
			state := schedule.DayStateUndefined
			if weekday == 1 {
				state = mondayState
			}
			if weekday == 4 {
				state = thursdayState
			}
			var period *schedule.WorkPeriod
			if state == schedule.DayStateWorkPeriod {
				period = &schedule.WorkPeriod{StartTime: "22:00", EndTime: "06:00"}
			}
			days[weekday-1] = schedule.PatternDay{Weekday: weekday, State: state, WorkPeriod: period}
		}
		encoded, err := json.Marshal(schedule.WeeklyPattern{EffectiveFrom: effectiveFrom, Weekdays: days})
		if err != nil {
			t.Fatalf("encode weekly pattern: %v", err)
		}
		return string(encoded)
	}
	participationBody := func(mondayState, thursdayState string) string {
		return `{"personId":"` + personResult.Person.ID + `","startDate":"2026-09-10","endDate":"2026-10-15","pattern":` + pattern("2026-09-07", mondayState, thursdayState) + `}`
	}
	var firstParticipation schedule.WeekParticipation
	for _, calendarID := range []string{initialScheduleID, scheduleResult.Schedule.ID} {
		response := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules/"+calendarID+"/participations", previewToken, participationBody(schedule.DayStateDayOff, schedule.DayStateWorkPeriod))
		if response.Code != http.StatusCreated {
			t.Fatalf("add overlapping participation to %s status = %d, want %d; body=%s", calendarID, response.Code, http.StatusCreated, response.Body)
		}
		if calendarID == initialScheduleID {
			var result struct {
				Participation schedule.WeekParticipation `json:"participation"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatalf("decode initial participation: %v", err)
			}
			firstParticipation = result.Participation
		}
	}

	viewResponse := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+spaceID, previewToken, "")
	if viewResponse.Code != http.StatusOK {
		t.Fatalf("read management space status = %d, want %d", viewResponse.Code, http.StatusOK)
	}
	var view schedule.ManagementSpaceView
	if err := json.Unmarshal(viewResponse.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode management space: %v", err)
	}
	if len(view.People) != 1 || view.People[0].ID != personResult.Person.ID || len(view.Schedules) != 2 {
		t.Fatalf("shared people/schedules = %d/%d, want the same single Person across two Schedules", len(view.People), len(view.Schedules))
	}
	for _, calendar := range view.Schedules {
		if len(calendar.Participations) != 1 || calendar.Participations[0].Person.ID != personResult.Person.ID {
			t.Fatalf("Schedule %q participation = %#v, want the same Person ID", calendar.ID, calendar.Participations)
		}
	}

	weekResponse := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+spaceID+"/schedules/"+initialScheduleID+"?weekStart=2026-09-07", previewToken, "")
	if weekResponse.Code != http.StatusOK {
		t.Fatalf("open derived week status = %d, want %d; body=%s", weekResponse.Code, http.StatusOK, weekResponse.Body)
	}
	var weekResult struct {
		Week schedule.ScheduleWeek `json:"week"`
	}
	if err := json.Unmarshal(weekResponse.Body.Bytes(), &weekResult); err != nil {
		t.Fatalf("decode week response: %v", err)
	}
	if got := weekResult.Week.People[0].Days[0].State; got != schedule.DayStateOutsideParticipation {
		t.Fatalf("Monday before start date = %q, want outside participation", got)
	}
	if got := weekResult.Week.People[0].Days[3].State; got != schedule.DayStateWorkPeriod {
		t.Fatalf("Thursday derived pattern = %q, want work period", got)
	}
	if got := weekResult.Week.People[0].Days[3].WorkPeriod.EndTime; got != "06:00" {
		t.Fatalf("overnight work period end = %q, want 06:00", got)
	}

	futurePattern := pattern("2026-10-05", schedule.DayStateWorkPeriod, schedule.DayStateDayOff)
	patternResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules/"+initialScheduleID+"/participations/"+firstParticipation.ID+"/patterns", previewToken, futurePattern)
	if patternResponse.Code != http.StatusCreated {
		t.Fatalf("add dated pattern version status = %d, want %d; body=%s", patternResponse.Code, http.StatusCreated, patternResponse.Body)
	}
	futureWeekResponse := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+spaceID+"/schedules/"+initialScheduleID+"?weekStart=2026-10-05", previewToken, "")
	if futureWeekResponse.Code != http.StatusOK {
		t.Fatalf("open future derived week status = %d, want %d; body=%s", futureWeekResponse.Code, http.StatusOK, futureWeekResponse.Body)
	}
	var futureWeek struct {
		Week schedule.ScheduleWeek `json:"week"`
	}
	if err := json.Unmarshal(futureWeekResponse.Body.Bytes(), &futureWeek); err != nil {
		t.Fatalf("decode future week response: %v", err)
	}
	if got := futureWeek.Week.People[0].Days[0].State; got != schedule.DayStateWorkPeriod {
		t.Fatalf("Monday after dated pattern version = %q, want work period", got)
	}

	unauthorized := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/people", "", `{"name":"Outsider"}`)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized person creation status = %d, want %d", unauthorized.Code, http.StatusUnauthorized)
	}
}

func TestManagementScheduleRejectsInvalidTimeZoneAndPatternStates(t *testing.T) {
	store := newSchedulingManagementSpaceStore()
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	spaceID := "11111111-1111-4111-8111-111111111111"

	invalidZone := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules", previewToken, `{"name":"Outra","timeZone":"Mars/Olympus"}`)
	if invalidZone.Code != http.StatusBadRequest {
		t.Fatalf("invalid time zone status = %d, want %d", invalidZone.Code, http.StatusBadRequest)
	}

	personResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/people", previewToken, `{"name":"Ana"}`)
	var personResult struct {
		Person schedule.Person `json:"person"`
	}
	if err := json.Unmarshal(personResponse.Body.Bytes(), &personResult); err != nil {
		t.Fatalf("decode person: %v", err)
	}
	badPattern := `{"personId":"` + personResult.Person.ID + `","startDate":"2026-09-10","pattern":{"effectiveFrom":"2026-09-07","weekdays":[` +
		`{"weekday":1,"state":"vacation"},` +
		`{"weekday":2,"state":"undefined"},{"weekday":3,"state":"undefined"},{"weekday":4,"state":"undefined"},{"weekday":5,"state":"undefined"},{"weekday":6,"state":"undefined"},{"weekday":7,"state":"undefined"}]}}`
	invalidState := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules/22222222-2222-4222-8222-222222222222/participations", previewToken, badPattern)
	if invalidState.Code != http.StatusBadRequest {
		t.Fatalf("date-specific state in weekly pattern status = %d, want %d", invalidState.Code, http.StatusBadRequest)
	}
}
