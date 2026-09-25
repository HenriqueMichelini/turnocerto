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

type schedulingManagementSpaceStore struct {
	*managementSpaceStore
}

func newSchedulingManagementSpaceStore() *schedulingManagementSpaceStore {
	store := &schedulingManagementSpaceStore{managementSpaceStore: &managementSpaceStore{}}
	space := schedule.ManagementSpace{ID: "11111111-1111-4111-8111-111111111111", Name: "Clínica Aurora"}
	calendar := schedule.Schedule{ID: "22222222-2222-4222-8222-222222222222", Name: "Equipe da manhã", TimeZone: "America/Sao_Paulo", Revision: "schedule-revision-1", ManagementSpace: space}
	store.spaces = map[string]schedule.ManagementSpaceView{
		space.ID: {ManagementSpace: space, Schedules: []schedule.Schedule{calendar}, People: []schedule.Person{}},
	}
	store.tokenHashes = map[string]string{space.ID: hashManagementToken(previewToken)}
	return store
}

func TestManagementScheduleEditsRequireManagementCredential(t *testing.T) {
	store := newSchedulingManagementSpaceStore()
	handler := schedule.NewHTTPHandlerWithManagement(&memoryScheduleStore{}, store, "preview", previewOrigin, "", schedule.ManagementSecurity{})
	response := managementRequest(handler, http.MethodPost,
		"/api/management-spaces/11111111-1111-4111-8111-111111111111/schedules/22222222-2222-4222-8222-222222222222/participations/33333333-3333-4333-8333-333333333333/edits",
		"", `{"revision":"version-1"}`)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("schedule edit without a management credential status = %d, want %d; body=%s", response.Code, http.StatusUnauthorized, response.Body)
	}
}

func TestPointEditChangesOnlySelectedDatesAndRejectsASecondEditorWithStaleRevision(t *testing.T) {
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
	days := make([]schedule.PatternDay, 7)
	for index := range days {
		days[index] = schedule.PatternDay{Weekday: index + 1, State: schedule.DayStateUndefined}
	}
	participationBody, err := json.Marshal(struct {
		PersonID  string                 `json:"personId"`
		StartDate string                 `json:"startDate"`
		Pattern   schedule.WeeklyPattern `json:"pattern"`
	}{personResult.Person.ID, "2026-09-07", schedule.WeeklyPattern{EffectiveFrom: "2026-09-07", Weekdays: days}})
	if err != nil {
		t.Fatal(err)
	}
	participationResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"/participations", previewToken, string(participationBody))
	if participationResponse.Code != http.StatusCreated {
		t.Fatalf("create participation status = %d, want %d; body=%s", participationResponse.Code, http.StatusCreated, participationResponse.Body)
	}
	var participationResult struct {
		Participation schedule.WeekParticipation `json:"participation"`
	}
	if err := json.Unmarshal(participationResponse.Body.Bytes(), &participationResult); err != nil {
		t.Fatal(err)
	}
	var openedRevision struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(participationResponse.Body.Bytes(), &openedRevision); err != nil {
		t.Fatal(err)
	}
	if openedRevision.Revision == "" {
		t.Fatal("creating a participation did not return the schedule revision")
	}
	path := "/api/management-spaces/" + spaceID + "/schedules/" + scheduleID + "/participations/" + participationResult.Participation.ID + "/edits"
	secondPersonResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/people", previewToken, `{"name":"Bruna"}`)
	var secondPersonResult struct {
		Person schedule.Person `json:"person"`
	}
	if err := json.Unmarshal(secondPersonResponse.Body.Bytes(), &secondPersonResult); err != nil {
		t.Fatal(err)
	}
	secondParticipationBody, err := json.Marshal(struct {
		PersonID  string                 `json:"personId"`
		StartDate string                 `json:"startDate"`
		Pattern   schedule.WeeklyPattern `json:"pattern"`
	}{secondPersonResult.Person.ID, "2026-09-07", schedule.WeeklyPattern{EffectiveFrom: "2026-09-07", Weekdays: days}})
	if err != nil {
		t.Fatal(err)
	}
	secondParticipationResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"/participations", previewToken, string(secondParticipationBody))
	if secondParticipationResponse.Code != http.StatusCreated {
		t.Fatalf("create second participation status = %d, want %d; body=%s", secondParticipationResponse.Code, http.StatusCreated, secondParticipationResponse.Body)
	}
	var secondParticipationResult struct {
		Participation schedule.WeekParticipation `json:"participation"`
	}
	if err := json.Unmarshal(secondParticipationResponse.Body.Bytes(), &secondParticipationResult); err != nil {
		t.Fatal(err)
	}
	secondPath := "/api/management-spaces/" + spaceID + "/schedules/" + scheduleID + "/participations/" + secondParticipationResult.Participation.ID + "/edits"
	latestWeekResponse := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"?weekStart=2026-09-07", previewToken, "")
	var latestWeekResult struct {
		Week schedule.ScheduleWeek `json:"week"`
	}
	if err := json.Unmarshal(latestWeekResponse.Body.Bytes(), &latestWeekResult); err != nil {
		t.Fatal(err)
	}
	openedRevision.Revision = latestWeekResult.Week.Revision
	firstEdit := schedule.ScheduleEdit{
		Revision:  openedRevision.Revision,
		WeekStart: "2026-09-07",
		Mode:      schedule.ScheduleEditOnce,
		Dates: []schedule.DateException{{
			Date:       "2026-09-08",
			State:      schedule.DayStateWorkPeriod,
			WorkPeriod: &schedule.WorkPeriod{StartTime: "09:00", EndTime: "17:00"},
		}},
	}
	body, err := json.Marshal(firstEdit)
	if err != nil {
		t.Fatal(err)
	}
	firstSave := managementRequest(handler, http.MethodPost, path, previewToken, string(body))
	if firstSave.Code != http.StatusOK {
		t.Fatalf("point edit status = %d, want %d; body=%s", firstSave.Code, http.StatusOK, firstSave.Body)
	}
	secondEdit := firstEdit
	secondEdit.Dates = []schedule.DateException{{Date: "2026-09-09", State: schedule.DayStateDayOff}}
	body, err = json.Marshal(secondEdit)
	if err != nil {
		t.Fatal(err)
	}
	secondSave := managementRequest(handler, http.MethodPost, secondPath, previewToken, string(body))
	if secondSave.Code != http.StatusConflict || !strings.Contains(secondSave.Body.String(), "stale_schedule_edit") {
		t.Fatalf("second save with the opened revision = %d %s, want a stale-save conflict", secondSave.Code, secondSave.Body)
	}

	weekResponse := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+spaceID+"/schedules/"+scheduleID+"?weekStart=2026-09-07", previewToken, "")
	var weekResult struct {
		Week schedule.ScheduleWeek `json:"week"`
	}
	if err := json.Unmarshal(weekResponse.Body.Bytes(), &weekResult); err != nil {
		t.Fatal(err)
	}
	if got := weekResult.Week.People[0].Days[1].State; got != schedule.DayStateWorkPeriod {
		t.Fatalf("Tuesday after the accepted edit = %q, want work_period", got)
	}
	if got := weekResult.Week.People[0].Days[2].State; got != schedule.DayStateUndefined {
		t.Fatalf("Wednesday after the stale edit = %q, want unchanged undefined", got)
	}
	spaceResponse := managementRequest(handler, http.MethodGet, "/api/management-spaces/"+spaceID, previewToken, "")
	var spaceResult schedule.ManagementSpaceView
	if err := json.Unmarshal(spaceResponse.Body.Bytes(), &spaceResult); err != nil {
		t.Fatal(err)
	}
	participation := spaceResult.Schedules[0].Participations[0]
	versions := participation.PatternVersions
	if len(versions) != 1 || versions[0].Weekdays[1].State != schedule.DayStateUndefined {
		t.Fatalf("point edit changed the Weekly Pattern: %#v", versions)
	}
	if len(participation.DateExceptions) != 1 || participation.DateExceptions[0].Date != "2026-09-08" || participation.DateExceptions[0].State != schedule.DayStateWorkPeriod {
		t.Fatalf("point edit exceptions after the stale attempt = %#v, want only the accepted Tuesday change", participation.DateExceptions)
	}
	if len(spaceResult.Schedules[0].Participations[1].DateExceptions) != 0 {
		t.Fatalf("stale save for second person partially applied: %#v", spaceResult.Schedules[0].Participations[1].DateExceptions)
	}
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

func (store *schedulingManagementSpaceStore) CreateParticipation(_ context.Context, spaceID, scheduleID, tokenHash string, participation schedule.WeekParticipation, expectedRevision, nextRevision string) error {
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ErrUnauthorized
	}
	for _, person := range view.People {
		if person.ID == participation.Person.ID {
			participation.Person = person
			for index, calendar := range view.Schedules {
				if calendar.ID == scheduleID {
					if calendar.Revision != expectedRevision {
						return schedule.ErrStaleScheduleEdit
					}
					calendar.Revision = nextRevision
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

func (store *schedulingManagementSpaceStore) SaveScheduleEdit(_ context.Context, spaceID, scheduleID, participationID, tokenHash string, edit schedule.ScheduleEdit, nextRevision string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	view, exists := store.spaces[spaceID]
	if !exists || store.tokenHashes[spaceID] != tokenHash {
		return schedule.ErrUnauthorized
	}
	for scheduleIndex, calendar := range view.Schedules {
		if calendar.ID != scheduleID {
			continue
		}
		if calendar.Revision != edit.Revision {
			return schedule.ErrStaleScheduleEdit
		}
		for participationIndex, participation := range calendar.Participations {
			if participation.ID != participationID {
				continue
			}
			switch edit.Mode {
			case schedule.ScheduleEditOnce:
				for _, exception := range edit.Dates {
					exists := false
					for index := range participation.DateExceptions {
						if participation.DateExceptions[index].Date == exception.Date {
							participation.DateExceptions[index] = exception
							exists = true
							break
						}
					}
					if !exists {
						participation.DateExceptions = append(participation.DateExceptions, exception)
					}
				}
				if len(edit.RemoveDates) != 0 {
					remove := make(map[string]bool, len(edit.RemoveDates))
					for _, date := range edit.RemoveDates {
						remove[date] = true
					}
					remaining := participation.DateExceptions[:0]
					for _, exception := range participation.DateExceptions {
						if !remove[exception.Date] {
							remaining = append(remaining, exception)
						}
					}
					participation.DateExceptions = remaining
				}
			case schedule.ScheduleEditRecurring:
				var base *schedule.WeeklyPattern
				for index := range participation.PatternVersions {
					version := &participation.PatternVersions[index]
					if version.EffectiveFrom <= edit.WeekStart && (base == nil || version.EffectiveFrom > base.EffectiveFrom) {
						base = version
					}
				}
				if base == nil {
					return schedule.ErrInvalidScheduleWeek
				}
				pattern := *base
				pattern.ID = edit.PatternID
				pattern.EffectiveFrom = edit.WeekStart
				pattern.Weekdays = append([]schedule.PatternDay(nil), base.Weekdays...)
				for _, update := range edit.Weekdays {
					found := false
					for index := range pattern.Weekdays {
						if pattern.Weekdays[index].Weekday == update.Weekday {
							pattern.Weekdays[index] = update
							found = true
							break
						}
					}
					if !found {
						pattern.Weekdays = append(pattern.Weekdays, update)
					}
				}
				replaced := false
				for index := range participation.PatternVersions {
					if participation.PatternVersions[index].EffectiveFrom == edit.WeekStart {
						participation.PatternVersions[index] = pattern
						replaced = true
						break
					}
				}
				if !replaced {
					participation.PatternVersions = append(participation.PatternVersions, pattern)
				}
				if edit.RemoveFutureExceptions {
					cutoff, err := schedule.FutureExceptionStartDate(calendar, edit.WeekStart, time.Now())
					if err != nil {
						return err
					}
					weekdays := make(map[int]bool, len(edit.Weekdays))
					for _, day := range edit.Weekdays {
						weekdays[day.Weekday] = true
					}
					remaining := participation.DateExceptions[:0]
					for _, exception := range participation.DateExceptions {
						parsed, _ := time.Parse("2006-01-02", exception.Date)
						weekday := (int(parsed.Weekday())+6)%7 + 1
						if exception.Date >= cutoff && weekdays[weekday] {
							continue
						}
						remaining = append(remaining, exception)
					}
					participation.DateExceptions = remaining
				}
			}
			calendar.Participations[participationIndex] = participation
			calendar.Revision = nextRevision
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
		Revision      string                     `json:"revision"`
	}
	if err := json.Unmarshal(participationResponse.Body.Bytes(), &participationResult); err != nil {
		t.Fatal(err)
	}
	if participationResult.Revision == "" {
		t.Fatal("create participation response omitted schedule revision")
	}
	path := "/api/management-spaces/" + spaceID + "/schedules/" + scheduleID + "/participations/" + participationResult.Participation.ID + "/edits"
	invalidEdit, err := json.Marshal(schedule.ScheduleEdit{
		Revision:  participationResult.Revision,
		WeekStart: "2026-09-14",
		Mode:      schedule.ScheduleEditOnce,
		Dates:     []schedule.DateException{{Date: "2026-09-14", State: schedule.DayStateVacation}},
	})
	if err != nil {
		t.Fatal(err)
	}
	outsideParticipation := managementRequest(handler, http.MethodPost, path, previewToken, string(invalidEdit))
	if outsideParticipation.Code != http.StatusBadRequest {
		t.Fatalf("out-of-range date exception status = %d, want %d", outsideParticipation.Code, http.StatusBadRequest)
	}
	edit := schedule.ScheduleEdit{
		Revision:  participationResult.Revision,
		WeekStart: "2026-09-07",
		Mode:      schedule.ScheduleEditOnce,
		Dates:     []schedule.DateException{{Date: "2026-09-11", State: schedule.DayStateVacation}},
	}
	editBody, err := json.Marshal(edit)
	if err != nil {
		t.Fatal(err)
	}
	exceptionResponse := managementRequest(handler, http.MethodPost, path, previewToken, string(editBody))
	if exceptionResponse.Code != http.StatusOK {
		t.Fatalf("create date exception status = %d, want %d; body=%s", exceptionResponse.Code, http.StatusOK, exceptionResponse.Body)
	}
	var updatedRevision struct {
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(exceptionResponse.Body.Bytes(), &updatedRevision); err != nil {
		t.Fatal(err)
	}
	edit.Revision = updatedRevision.Revision
	edit.Dates = []schedule.DateException{{Date: "2026-09-11", State: schedule.DayStateAbsence}}
	editBody, err = json.Marshal(edit)
	if err != nil {
		t.Fatal(err)
	}
	updateResponse := managementRequest(handler, http.MethodPost, path, previewToken, string(editBody))
	if updateResponse.Code != http.StatusOK {
		t.Fatalf("update date exception status = %d, want %d; body=%s", updateResponse.Code, http.StatusOK, updateResponse.Body)
	}
	if err := json.Unmarshal(updateResponse.Body.Bytes(), &updatedRevision); err != nil {
		t.Fatal(err)
	}
	edit.Revision = updatedRevision.Revision
	edit.Dates = nil
	edit.RemoveDates = []string{"2026-09-11"}
	removeBody, err := json.Marshal(edit)
	if err != nil {
		t.Fatal(err)
	}
	removeResponse := managementRequest(handler, http.MethodPost, path, previewToken, string(removeBody))
	if removeResponse.Code != http.StatusOK {
		t.Fatalf("remove date exception status = %d, want %d; body=%s", removeResponse.Code, http.StatusOK, removeResponse.Body)
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
	if got := weekResult.Week.People[0].Days[4].State; got != schedule.DayStateDayOff {
		t.Fatalf("Friday derived state after removing exception = %q, want underlying day_off pattern", got)
	}
	if weekResult.Week.People[0].Days[4].HasException {
		t.Fatal("removed Friday exception still appears in the derived week")
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
	var futurePatternVersion schedule.WeeklyPattern
	if err := json.Unmarshal([]byte(futurePattern), &futurePatternVersion); err != nil {
		t.Fatal(err)
	}
	patternEdit := schedule.ScheduleEdit{
		Revision:  weekResult.Week.Revision,
		WeekStart: futurePatternVersion.EffectiveFrom,
		Mode:      schedule.ScheduleEditRecurring,
		Weekdays:  []schedule.PatternDay{futurePatternVersion.Weekdays[0], futurePatternVersion.Weekdays[3]},
	}
	patternEditBody, err := json.Marshal(patternEdit)
	if err != nil {
		t.Fatal(err)
	}
	patternResponse := managementRequest(handler, http.MethodPost, "/api/management-spaces/"+spaceID+"/schedules/"+initialScheduleID+"/participations/"+firstParticipation.ID+"/edits", previewToken, string(patternEditBody))
	if patternResponse.Code != http.StatusOK {
		t.Fatalf("add dated pattern version status = %d, want %d; body=%s", patternResponse.Code, http.StatusOK, patternResponse.Body)
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
