//go:build js && wasm

package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"syscall/js"
	"time"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

const scheduleQuery = `SELECT schedules.id, schedules.name,
       schedules.time_zone AS scheduleTimeZone,
       management_spaces.id AS managementSpaceId,
       management_spaces.name AS managementSpaceName
FROM schedules
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
WHERE schedules.id = ?`

const renameScheduleQuery = `UPDATE schedules
SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ?`

const createManagementSpaceQuery = `INSERT INTO management_spaces (id, name, management_token_hash)
VALUES (?, ?, ?)`

const createManagementScheduleQuery = `INSERT INTO schedules (id, management_space_id, name, time_zone)
VALUES (?, ?, ?, ?)`

const renameManagementSpaceQuery = `UPDATE management_spaces
SET name = ?
WHERE id = ? AND management_token_hash = ?`

const replaceManagementTokenQuery = `UPDATE management_spaces
SET management_token_hash = ?
WHERE id = ? AND management_token_hash = ?`

const getManagementSpaceNameQuery = `SELECT id, name
FROM management_spaces
WHERE id = ?`

const getManagementSpaceQuery = `SELECT management_spaces.id AS managementSpaceId,
       management_spaces.name AS managementSpaceName,
       schedules.id AS scheduleId,
       schedules.name AS scheduleName,
       schedules.time_zone AS scheduleTimeZone
FROM management_spaces
LEFT JOIN schedules ON schedules.management_space_id = management_spaces.id
WHERE management_spaces.id = ? AND management_spaces.management_token_hash = ?
ORDER BY schedules.rowid`

const renameManagementScheduleQuery = `UPDATE schedules
SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ? AND management_space_id = ?
  AND EXISTS (
    SELECT 1 FROM management_spaces
    WHERE id = ? AND management_token_hash = ?
  )`

const getManagementScheduleQuery = `SELECT schedules.id, schedules.name,
       schedules.time_zone AS scheduleTimeZone,
       management_spaces.id AS managementSpaceId,
       management_spaces.name AS managementSpaceName
FROM schedules
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
WHERE schedules.id = ? AND management_spaces.id = ?`

const updateManagementScheduleTimeZoneQuery = `UPDATE schedules
SET time_zone = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id = ? AND management_space_id = ?
  AND EXISTS (
    SELECT 1 FROM management_spaces
    WHERE id = ? AND management_token_hash = ?
  )`

const getPeopleQuery = `SELECT people.id, people.name
FROM people
INNER JOIN management_spaces ON management_spaces.id = people.management_space_id
WHERE management_spaces.id = ? AND management_spaces.management_token_hash = ?
ORDER BY people.name COLLATE NOCASE, people.id`

const getScheduleParticipationsQuery = `SELECT participations.id AS participationId,
       participations.person_id AS personId,
       people.name AS personName,
       participations.start_date AS startDate,
       participations.end_date AS endDate,
       weekly_patterns.id AS patternId,
       weekly_patterns.effective_from AS effectiveFrom,
       weekly_pattern_days.weekday AS weekday,
       weekly_pattern_days.state AS state,
       weekly_pattern_days.start_time AS startTime,
       weekly_pattern_days.end_time AS endTime,
       weekly_pattern_days.break_start_time AS breakStartTime,
       weekly_pattern_days.break_end_time AS breakEndTime,
       schedules.id AS scheduleId
FROM participations
INNER JOIN schedules ON schedules.id = participations.schedule_id
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
INNER JOIN people ON people.id = participations.person_id
LEFT JOIN weekly_patterns ON weekly_patterns.participation_id = participations.id
LEFT JOIN weekly_pattern_days ON weekly_pattern_days.weekly_pattern_id = weekly_patterns.id
WHERE management_spaces.id = ? AND management_spaces.management_token_hash = ?
ORDER BY schedules.rowid, people.name COLLATE NOCASE, participations.start_date,
         weekly_patterns.effective_from, weekly_pattern_days.weekday`

const getParticipationExceptionsQuery = `SELECT participation_date_exceptions.participation_id AS participationId,
       participation_date_exceptions.exception_date AS exceptionDate,
       participation_date_exceptions.state AS state,
       schedules.id AS scheduleId
FROM participation_date_exceptions
INNER JOIN participations ON participations.id = participation_date_exceptions.participation_id
INNER JOIN schedules ON schedules.id = participations.schedule_id
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
WHERE management_spaces.id = ? AND management_spaces.management_token_hash = ?
ORDER BY participation_date_exceptions.exception_date`

const createScheduleForSpaceQuery = `INSERT INTO schedules (id, management_space_id, name, time_zone)
SELECT ?, management_spaces.id, ?, ?
FROM management_spaces
WHERE management_spaces.id = ? AND management_spaces.management_token_hash = ?`

const createPersonForSpaceQuery = `INSERT INTO people (id, management_space_id, name)
SELECT ?, management_spaces.id, ?
FROM management_spaces
WHERE management_spaces.id = ? AND management_spaces.management_token_hash = ?`

const createParticipationQuery = `INSERT INTO participations (id, schedule_id, person_id, start_date, end_date)
SELECT ?, schedules.id, people.id, ?, ?
FROM schedules
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
INNER JOIN people ON people.management_space_id = management_spaces.id AND people.id = ?
WHERE management_spaces.id = ? AND schedules.id = ? AND management_spaces.management_token_hash = ?`

const createWeeklyPatternQuery = `INSERT INTO weekly_patterns (id, participation_id, effective_from)
SELECT ?, participations.id, ?
FROM participations
INNER JOIN schedules ON schedules.id = participations.schedule_id
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
WHERE management_spaces.id = ? AND schedules.id = ? AND participations.id = ?
  AND management_spaces.management_token_hash = ?`

const createWeeklyPatternDayQuery = `INSERT INTO weekly_pattern_days
  (weekly_pattern_id, weekday, state, start_time, end_time, break_start_time, break_end_time)
VALUES (?, ?, ?, ?, ?, ?, ?)`

const createDateExceptionQuery = `INSERT INTO participation_date_exceptions
  (id, participation_id, exception_date, state)
SELECT ?, participations.id, ?, ?
FROM participations
INNER JOIN schedules ON schedules.id = participations.schedule_id
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
WHERE management_spaces.id = ? AND schedules.id = ? AND participations.id = ?
  AND management_spaces.management_token_hash = ?
ON CONFLICT (participation_id, exception_date) DO UPDATE
SET id = excluded.id, state = excluded.state`

const getParticipationScopeQuery = `SELECT participations.id, participations.start_date, participations.end_date, schedules.time_zone
FROM participations
INNER JOIN schedules ON schedules.id = participations.schedule_id
INNER JOIN management_spaces ON management_spaces.id = schedules.management_space_id
WHERE management_spaces.id = ? AND schedules.id = ? AND participations.id = ?
  AND management_spaces.management_token_hash = ?`

type d1Store struct {
	database js.Value
}

type promiseResult struct {
	value js.Value
	err   error
}

type workerResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

type cloudflareRateLimiter struct {
	binding js.Value
}

func (response *workerResponse) Header() http.Header {
	return response.header
}

func (response *workerResponse) WriteHeader(status int) {
	if response.status == 0 {
		response.status = status
	}
}

func (response *workerResponse) Write(body []byte) (int, error) {
	if response.status == 0 {
		response.status = http.StatusOK
	}
	return response.body.Write(body)
}

var workerFetch js.Func

func main() {
	workerFetch = js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 2 {
			return newPromise(func(_ js.Value, callbacks []js.Value) any {
				callbacks[1].Invoke("Invalid Worker request")
				return nil
			})
		}
		request, env := args[0], args[1]
		return newPromise(func(_ js.Value, callbacks []js.Value) any {
			resolve := callbacks[0]
			go func() {
				resolve.Invoke(handleRequest(request, env))
			}()
			return nil
		})
	})
	js.Global().Set("turnocertoFetch", workerFetch)
	select {}
}

func newPromise(executor func(js.Value, []js.Value) any) js.Value {
	function := js.FuncOf(executor)
	promise := js.Global().Get("Promise").New(function)
	function.Release()
	return promise
}

func handleRequest(requestValue, env js.Value) (response js.Value) {
	defer func() {
		if recover() != nil {
			response = failureResponse(requestValue, env)
		}
	}()

	method := requestValue.Get("method").String()
	url := requestValue.Get("url").String()
	body := ""
	if method == http.MethodPatch || method == http.MethodPost {
		bodyValue, err := awaitPromise(requestValue.Call("text"))
		if err != nil {
			return failureResponse(requestValue, env)
		}
		body = bodyValue.String()
	}

	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		return failureResponse(requestValue, env)
	}
	request.Header.Set("Content-Type", headerValue(requestValue, "content-type"))
	request.Header.Set("Origin", headerValue(requestValue, "origin"))
	if length := headerValue(requestValue, "content-length"); length != "" {
		request.Header.Set("Content-Length", length)
	}
	if accept := headerValue(requestValue, "accept"); accept != "" {
		request.Header.Set("Accept", accept)
	}
	if authorization := headerValue(requestValue, "authorization"); authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	if clientIP := headerValue(requestValue, "cf-connecting-ip"); clientIP != "" {
		request.Header.Set("CF-Connecting-IP", clientIP)
	}

	store := d1Store{database: env.Get("DB")}
	appEnv := environmentValue(env, "APP_ENV")
	webOrigin := environmentValue(env, "WEB_ORIGIN")
	previewTokenHash := environmentValue(env, "PREVIEW_TOKEN_HASH")
	security := schedule.ManagementSecurity{
		ChallengeVerifier: schedule.NewTurnstileVerifier(environmentValue(env, "TURNSTILE_SECRET_KEY")),
		CreationRateLimiter: cloudflareRateLimiter{
			binding: env.Get("CREATION_RATE_LIMITER"),
		},
		ChallengeHostname: environmentValue(env, "TURNSTILE_ALLOWED_HOSTNAME"),
	}
	handler := schedule.NewHTTPHandlerWithManagement(store, store, appEnv, webOrigin, previewTokenHash, security)
	responseRecorder := &workerResponse{header: make(http.Header)}
	handler.ServeHTTP(responseRecorder, request)
	status := responseRecorder.status
	if status == 0 {
		status = http.StatusOK
	}
	return jsResponse(status, responseRecorder.Header(), responseRecorder.body.Bytes())
}

func (store d1Store) GetSchedule(_ context.Context, id string) (schedule.Schedule, error) {
	statement := store.database.Call("prepare", scheduleQuery).Call("bind", id)
	row, err := awaitPromise(statement.Call("first"))
	if err != nil {
		return schedule.Schedule{}, err
	}
	if row.IsNull() || row.IsUndefined() {
		return schedule.Schedule{}, schedule.ErrNotFound
	}
	return schedule.Schedule{
		ID:       row.Get("id").String(),
		Name:     row.Get("name").String(),
		TimeZone: row.Get("scheduleTimeZone").String(),
		ManagementSpace: schedule.ManagementSpace{
			ID:   row.Get("managementSpaceId").String(),
			Name: row.Get("managementSpaceName").String(),
		},
	}, nil
}

func (store d1Store) RenameSchedule(ctx context.Context, id, name string) (schedule.Schedule, error) {
	if err := store.runPreparedUpdate(renameScheduleQuery, name, id); err != nil {
		return schedule.Schedule{}, err
	}
	return store.GetSchedule(ctx, id)
}

func (store d1Store) CreateManagementSpace(_ context.Context, managementSpace schedule.ManagementSpace, firstSchedule schedule.Schedule, tokenHash string) error {
	statements := js.Global().Get("Array").New()
	statements.Call("push", store.database.Call("prepare", createManagementSpaceQuery).Call("bind", managementSpace.ID, managementSpace.Name, tokenHash))
	statements.Call("push", store.database.Call("prepare", createManagementScheduleQuery).Call("bind", firstSchedule.ID, managementSpace.ID, firstSchedule.Name, firstSchedule.TimeZone))
	if _, err := awaitPromise(store.database.Call("batch", statements)); err != nil {
		return err
	}
	return nil
}

func (store d1Store) GetManagementSpace(_ context.Context, id, tokenHash string) (schedule.ManagementSpaceView, error) {
	statement := store.database.Call("prepare", getManagementSpaceQuery).Call("bind", id, tokenHash)
	result, err := awaitPromise(statement.Call("all"))
	if err != nil {
		return schedule.ManagementSpaceView{}, err
	}
	rows := result.Get("results")
	if rows.IsUndefined() || rows.IsNull() || rows.Length() == 0 {
		return schedule.ManagementSpaceView{}, schedule.ErrUnauthorized
	}
	first := rows.Index(0)
	managementSpace := schedule.ManagementSpace{
		ID:   first.Get("managementSpaceId").String(),
		Name: first.Get("managementSpaceName").String(),
	}
	view := schedule.ManagementSpaceView{
		ManagementSpace: managementSpace,
		Schedules:       make([]schedule.Schedule, 0, rows.Length()),
		People:          make([]schedule.Person, 0),
	}
	for index := 0; index < rows.Length(); index++ {
		row := rows.Index(index)
		scheduleID := row.Get("scheduleId")
		if scheduleID.IsNull() || scheduleID.IsUndefined() {
			continue
		}
		view.Schedules = append(view.Schedules, schedule.Schedule{
			ID:              scheduleID.String(),
			Name:            row.Get("scheduleName").String(),
			TimeZone:        row.Get("scheduleTimeZone").String(),
			ManagementSpace: managementSpace,
			Participations:  make([]schedule.WeekParticipation, 0),
		})
	}
	if err := store.loadManagementSpaceScheduleData(id, tokenHash, &view); err != nil {
		return schedule.ManagementSpaceView{}, err
	}
	return view, nil
}

func (store d1Store) loadManagementSpaceScheduleData(id, tokenHash string, view *schedule.ManagementSpaceView) error {
	peopleStatement := store.database.Call("prepare", getPeopleQuery).Call("bind", id, tokenHash)
	peopleResult, err := awaitPromise(peopleStatement.Call("all"))
	if err != nil {
		return err
	}
	peopleRows := peopleResult.Get("results")
	if !peopleRows.IsUndefined() && !peopleRows.IsNull() {
		for index := 0; index < peopleRows.Length(); index++ {
			row := peopleRows.Index(index)
			view.People = append(view.People, schedule.Person{ID: valueString(row.Get("id")), Name: valueString(row.Get("name"))})
		}
	}

	scheduleIndexes := make(map[string]int, len(view.Schedules))
	for index, calendar := range view.Schedules {
		scheduleIndexes[calendar.ID] = index
	}
	participationIndexes := make(map[string]struct {
		scheduleIndex      int
		participationIndex int
	})
	patternIndexes := make(map[string]map[string]int)
	statement := store.database.Call("prepare", getScheduleParticipationsQuery).Call("bind", id, tokenHash)
	result, err := awaitPromise(statement.Call("all"))
	if err != nil {
		return err
	}
	rows := result.Get("results")
	if rows.IsUndefined() || rows.IsNull() {
		return nil
	}
	for index := 0; index < rows.Length(); index++ {
		row := rows.Index(index)
		scheduleID := valueString(row.Get("scheduleId"))
		scheduleIndex, exists := scheduleIndexes[scheduleID]
		if !exists {
			continue
		}
		participationID := valueString(row.Get("participationId"))
		participationRef, exists := participationIndexes[participationID]
		if !exists {
			participation := schedule.WeekParticipation{
				ID:                 participationID,
				Person:             schedule.Person{ID: valueString(row.Get("personId")), Name: valueString(row.Get("personName"))},
				ParticipationStart: valueString(row.Get("startDate")),
				ParticipationEnd:   optionalString(row.Get("endDate")),
				PatternVersions:    make([]schedule.WeeklyPattern, 0),
			}
			calendar := view.Schedules[scheduleIndex]
			calendar.Participations = append(calendar.Participations, participation)
			view.Schedules[scheduleIndex] = calendar
			participationRef = struct {
				scheduleIndex      int
				participationIndex int
			}{scheduleIndex: scheduleIndex, participationIndex: len(calendar.Participations) - 1}
			participationIndexes[participationID] = participationRef
		}

		patternID := valueString(row.Get("patternId"))
		if patternID == "" {
			continue
		}
		indices, exists := patternIndexes[participationID]
		if !exists {
			indices = make(map[string]int)
			patternIndexes[participationID] = indices
		}
		calendar := view.Schedules[participationRef.scheduleIndex]
		participation := calendar.Participations[participationRef.participationIndex]
		patternIndex, exists := indices[patternID]
		if !exists {
			participation.PatternVersions = append(participation.PatternVersions, schedule.WeeklyPattern{
				ID:            patternID,
				EffectiveFrom: valueString(row.Get("effectiveFrom")),
				Weekdays:      make([]schedule.PatternDay, 0, 7),
			})
			patternIndex = len(participation.PatternVersions) - 1
			indices[patternID] = patternIndex
		}
		weekdayValue := row.Get("weekday")
		if weekdayValue.IsNull() || weekdayValue.IsUndefined() {
			continue
		}
		weekday, err := safeNumber(weekdayValue)
		if err != nil {
			return err
		}
		patternDay := schedule.PatternDay{Weekday: weekday, State: valueString(row.Get("state"))}
		if patternDay.State == schedule.DayStateWorkPeriod {
			patternDay.WorkPeriod = &schedule.WorkPeriod{
				StartTime:      valueString(row.Get("startTime")),
				EndTime:        valueString(row.Get("endTime")),
				BreakStartTime: valueString(row.Get("breakStartTime")),
				BreakEndTime:   valueString(row.Get("breakEndTime")),
			}
		}
		participation.PatternVersions[patternIndex].Weekdays = append(participation.PatternVersions[patternIndex].Weekdays, patternDay)
		calendar.Participations[participationRef.participationIndex] = participation
		view.Schedules[participationRef.scheduleIndex] = calendar
	}
	exceptionStatement := store.database.Call("prepare", getParticipationExceptionsQuery).Call("bind", id, tokenHash)
	exceptionResult, err := awaitPromise(exceptionStatement.Call("all"))
	if err != nil {
		return err
	}
	exceptionRows := exceptionResult.Get("results")
	if exceptionRows.IsUndefined() || exceptionRows.IsNull() {
		return nil
	}
	for index := 0; index < exceptionRows.Length(); index++ {
		row := exceptionRows.Index(index)
		participationRef, exists := participationIndexes[valueString(row.Get("participationId"))]
		if !exists || valueString(row.Get("scheduleId")) != view.Schedules[participationRef.scheduleIndex].ID {
			continue
		}
		calendar := view.Schedules[participationRef.scheduleIndex]
		participation := calendar.Participations[participationRef.participationIndex]
		participation.DateExceptions = append(participation.DateExceptions, schedule.DateException{
			Date:  valueString(row.Get("exceptionDate")),
			State: valueString(row.Get("state")),
		})
		calendar.Participations[participationRef.participationIndex] = participation
		view.Schedules[participationRef.scheduleIndex] = calendar
	}
	return nil
}

func (store d1Store) CreateSchedule(ctx context.Context, spaceID, tokenHash string, newSchedule schedule.Schedule) error {
	changes, err := store.runPreparedChanges(createScheduleForSpaceQuery, newSchedule.ID, newSchedule.Name, newSchedule.TimeZone, spaceID, tokenHash)
	if err != nil {
		return err
	}
	if changes == 1 {
		return nil
	}
	if _, authErr := store.GetManagementSpace(ctx, spaceID, tokenHash); authErr != nil {
		return schedule.ErrUnauthorized
	}
	return schedule.ErrNotFound
}

func (store d1Store) CreatePerson(ctx context.Context, spaceID, tokenHash string, person schedule.Person) error {
	changes, err := store.runPreparedChanges(createPersonForSpaceQuery, person.ID, person.Name, spaceID, tokenHash)
	if err != nil {
		return err
	}
	if changes == 1 {
		return nil
	}
	if _, authErr := store.GetManagementSpace(ctx, spaceID, tokenHash); authErr != nil {
		return schedule.ErrUnauthorized
	}
	return schedule.ErrNotFound
}

func (store d1Store) UpdateScheduleTimeZone(ctx context.Context, spaceID, scheduleID, tokenHash, timeZone string) (schedule.Schedule, error) {
	changes, err := store.runPreparedChanges(updateManagementScheduleTimeZoneQuery, timeZone, scheduleID, spaceID, spaceID, tokenHash)
	if err != nil {
		return schedule.Schedule{}, err
	}
	if changes == 0 {
		if _, authErr := store.GetManagementSpace(ctx, spaceID, tokenHash); authErr != nil {
			return schedule.Schedule{}, schedule.ErrUnauthorized
		}
		return schedule.Schedule{}, schedule.ErrNotFound
	}
	view, err := store.GetManagementSpace(ctx, spaceID, tokenHash)
	if err != nil {
		return schedule.Schedule{}, err
	}
	for _, calendar := range view.Schedules {
		if calendar.ID == scheduleID {
			return calendar, nil
		}
	}
	return schedule.Schedule{}, schedule.ErrNotFound
}

func (store d1Store) CreateParticipation(ctx context.Context, spaceID, scheduleID, tokenHash string, participation schedule.WeekParticipation) error {
	view, err := store.GetManagementSpace(ctx, spaceID, tokenHash)
	if err != nil {
		return err
	}
	if !containsSchedule(view.Schedules, scheduleID) || !containsPerson(view.People, participation.Person.ID) {
		return schedule.ErrNotFound
	}
	if len(participation.PatternVersions) != 1 {
		return schedule.ErrInvalidScheduleWeek
	}
	pattern := participation.PatternVersions[0]
	statements := js.Global().Get("Array").New()
	endDate := any(nil)
	if participation.ParticipationEnd != nil {
		endDate = *participation.ParticipationEnd
	}
	statements.Call("push", store.database.Call("prepare", createParticipationQuery).Call("bind", participation.ID, participation.ParticipationStart, endDate, participation.Person.ID, spaceID, scheduleID, tokenHash))
	store.appendWeeklyPatternStatements(statements, spaceID, scheduleID, participation.ID, tokenHash, pattern)
	_, err = awaitPromise(store.database.Call("batch", statements))
	return err
}

func (store d1Store) CreateWeeklyPattern(ctx context.Context, spaceID, scheduleID, participationID, tokenHash string, pattern schedule.WeeklyPattern) error {
	scope, err := store.firstPreparedRow(getParticipationScopeQuery, spaceID, scheduleID, participationID, tokenHash)
	if err != nil {
		return err
	}
	if scope.IsNull() || scope.IsUndefined() {
		if _, authErr := store.GetManagementSpace(ctx, spaceID, tokenHash); authErr != nil {
			return schedule.ErrUnauthorized
		}
		return schedule.ErrNotFound
	}
	participationStart := valueString(scope.Get("start_date"))
	if pattern.EffectiveFrom <= participationStart {
		return schedule.ErrInvalidScheduleWeek
	}
	timeZone := valueString(scope.Get("time_zone"))
	location, err := time.LoadLocation(timeZone)
	if err != nil {
		return schedule.ErrInvalidScheduleWeek
	}
	localNow := time.Now().In(location)
	weekStart := localNow.AddDate(0, 0, -((int(localNow.Weekday()) + 6) % 7)).Format("2006-01-02")
	if pattern.EffectiveFrom < weekStart {
		return schedule.ErrInvalidScheduleWeek
	}
	statements := js.Global().Get("Array").New()
	store.appendWeeklyPatternStatements(statements, spaceID, scheduleID, participationID, tokenHash, pattern)
	_, err = awaitPromise(store.database.Call("batch", statements))
	return err
}

func (store d1Store) CreateDateException(ctx context.Context, spaceID, scheduleID, participationID, tokenHash string, exception schedule.DateException) error {
	scope, err := store.firstPreparedRow(getParticipationScopeQuery, spaceID, scheduleID, participationID, tokenHash)
	if err != nil {
		return err
	}
	if scope.IsNull() || scope.IsUndefined() {
		if _, authErr := store.GetManagementSpace(ctx, spaceID, tokenHash); authErr != nil {
			return schedule.ErrUnauthorized
		}
		return schedule.ErrNotFound
	}
	if schedule.ValidateDateException(exception) != nil {
		return schedule.ErrInvalidScheduleWeek
	}
	startDate := valueString(scope.Get("start_date"))
	endDate := optionalString(scope.Get("end_date"))
	if exception.Date < startDate || (endDate != nil && exception.Date > *endDate) {
		return schedule.ErrInvalidScheduleWeek
	}
	changes, err := store.runPreparedChanges(createDateExceptionQuery, exception.ID, exception.Date, exception.State, spaceID, scheduleID, participationID, tokenHash)
	if err != nil {
		return err
	}
	if changes != 1 {
		return schedule.ErrNotFound
	}
	return nil
}

func (store d1Store) appendWeeklyPatternStatements(statements js.Value, spaceID, scheduleID, participationID, tokenHash string, pattern schedule.WeeklyPattern) {
	statements.Call("push", store.database.Call("prepare", createWeeklyPatternQuery).Call("bind", pattern.ID, pattern.EffectiveFrom, spaceID, scheduleID, participationID, tokenHash))
	for _, day := range pattern.Weekdays {
		var startTime, endTime, breakStartTime, breakEndTime any
		if day.WorkPeriod != nil {
			startTime = day.WorkPeriod.StartTime
			endTime = day.WorkPeriod.EndTime
			if day.WorkPeriod.BreakStartTime != "" {
				breakStartTime = day.WorkPeriod.BreakStartTime
				breakEndTime = day.WorkPeriod.BreakEndTime
			}
		}
		statements.Call("push", store.database.Call("prepare", createWeeklyPatternDayQuery).Call("bind", pattern.ID, day.Weekday, day.State, startTime, endTime, breakStartTime, breakEndTime))
	}
}

func (store d1Store) ReplaceManagementToken(_ context.Context, id, currentTokenHash, nextTokenHash string) (bool, error) {
	changes, err := store.runPreparedChanges(replaceManagementTokenQuery, nextTokenHash, id, currentTokenHash)
	if err != nil {
		return false, err
	}
	if changes > 1 {
		return false, errors.New("credential replacement updated more than one Management Space")
	}
	return changes == 1, nil
}

func (store d1Store) RenameManagementSpace(ctx context.Context, id, tokenHash, name string) (schedule.ManagementSpace, error) {
	if err := store.runPreparedUpdate(renameManagementSpaceQuery, name, id, tokenHash); err != nil {
		if errors.Is(err, schedule.ErrNotFound) {
			if _, authorizationErr := store.GetManagementSpace(ctx, id, tokenHash); authorizationErr != nil {
				return schedule.ManagementSpace{}, schedule.ErrUnauthorized
			}
		}
		return schedule.ManagementSpace{}, err
	}
	row, err := store.firstPreparedRow(getManagementSpaceNameQuery, id)
	if err != nil {
		return schedule.ManagementSpace{}, err
	}
	if row.IsNull() || row.IsUndefined() {
		return schedule.ManagementSpace{}, schedule.ErrNotFound
	}
	return schedule.ManagementSpace{ID: row.Get("id").String(), Name: row.Get("name").String()}, nil
}

func (store d1Store) RenameManagementSchedule(ctx context.Context, spaceID, scheduleID, tokenHash, name string) (schedule.Schedule, error) {
	if err := store.runPreparedUpdate(renameManagementScheduleQuery, name, scheduleID, spaceID, spaceID, tokenHash); err != nil {
		if errors.Is(err, schedule.ErrNotFound) {
			if _, authorizationErr := store.GetManagementSpace(ctx, spaceID, tokenHash); authorizationErr != nil {
				return schedule.Schedule{}, schedule.ErrUnauthorized
			}
		}
		return schedule.Schedule{}, err
	}
	row, err := store.firstPreparedRow(getManagementScheduleQuery, scheduleID, spaceID)
	if err != nil {
		return schedule.Schedule{}, err
	}
	if row.IsNull() || row.IsUndefined() {
		return schedule.Schedule{}, schedule.ErrNotFound
	}
	return schedule.Schedule{
		ID:       row.Get("id").String(),
		Name:     row.Get("name").String(),
		TimeZone: row.Get("scheduleTimeZone").String(),
		ManagementSpace: schedule.ManagementSpace{
			ID:   row.Get("managementSpaceId").String(),
			Name: row.Get("managementSpaceName").String(),
		},
	}, nil
}

func (store d1Store) runPreparedUpdate(query string, bindings ...any) error {
	changes, err := store.runPreparedChanges(query, bindings...)
	if err != nil {
		return err
	}
	if changes != 1 {
		return schedule.ErrNotFound
	}
	return nil
}

func (store d1Store) runPreparedChanges(query string, bindings ...any) (int, error) {
	statement := store.database.Call("prepare", query).Call("bind", bindings...)
	result, err := awaitPromise(statement.Call("run"))
	if err != nil {
		return 0, err
	}
	changes, err := safeNumber(result.Get("meta").Get("changes"))
	if err != nil {
		return 0, err
	}
	return changes, nil
}

func (store d1Store) firstPreparedRow(query string, bindings ...any) (js.Value, error) {
	statement := store.database.Call("prepare", query).Call("bind", bindings...)
	return awaitPromise(statement.Call("first"))
}

func valueString(value js.Value) string {
	if value.IsNull() || value.IsUndefined() {
		return ""
	}
	return value.String()
}

func optionalString(value js.Value) *string {
	text := valueString(value)
	if text == "" {
		return nil
	}
	return &text
}

func containsSchedule(schedules []schedule.Schedule, id string) bool {
	for _, calendar := range schedules {
		if calendar.ID == id {
			return true
		}
	}
	return false
}

func containsPerson(people []schedule.Person, id string) bool {
	for _, person := range people {
		if person.ID == id {
			return true
		}
	}
	return false
}

func (limiter cloudflareRateLimiter) Allow(_ context.Context, key string) (bool, error) {
	if limiter.binding.IsUndefined() || limiter.binding.IsNull() {
		return false, errors.New("creation rate limit binding is not configured")
	}
	options := js.Global().Get("Object").New()
	options.Set("key", key)
	result, err := awaitPromise(limiter.binding.Call("limit", options))
	if err != nil {
		return false, err
	}
	success := result.Get("success")
	if success.Type() != js.TypeBoolean {
		return false, errors.New("creation rate limit returned an invalid result")
	}
	return success.Bool(), nil
}

func awaitPromise(promise js.Value) (js.Value, error) {
	result := make(chan promiseResult, 1)
	resolved := js.FuncOf(func(_ js.Value, values []js.Value) any {
		if len(values) == 0 {
			result <- promiseResult{err: errors.New("promise resolved without a value")}
		} else {
			result <- promiseResult{value: values[0]}
		}
		return nil
	})
	rejected := js.FuncOf(func(_ js.Value, values []js.Value) any {
		message := "promise rejected"
		if len(values) > 0 {
			message = values[0].String()
		}
		result <- promiseResult{err: errors.New(message)}
		return nil
	})
	promise.Call("then", resolved).Call("catch", rejected)
	outcome := <-result
	resolved.Release()
	rejected.Release()
	return outcome.value, outcome.err
}

func safeNumber(value js.Value) (number int, err error) {
	defer func() {
		if recover() != nil {
			err = fmt.Errorf("invalid numeric result")
		}
	}()
	return value.Int(), nil
}

func headerValue(request js.Value, name string) string {
	value := request.Get("headers").Call("get", name)
	if value.IsNull() || value.IsUndefined() {
		return ""
	}
	return value.String()
}

func environmentValue(env js.Value, name string) string {
	value := env.Get(name)
	if value.IsUndefined() || value.IsNull() {
		return ""
	}
	return value.String()
}

func jsResponse(status int, headers http.Header, body []byte) js.Value {
	jsHeaders := js.Global().Get("Object").New()
	for name, values := range headers {
		jsHeaders.Set(name, strings.Join(values, ", "))
	}
	options := js.Global().Get("Object").New()
	options.Set("status", status)
	options.Set("headers", jsHeaders)
	var responseBody any = string(body)
	if status == http.StatusNoContent {
		responseBody = js.Null()
	}
	return js.Global().Get("Response").New(responseBody, options)
}

func failureResponse(request, env js.Value) js.Value {
	headers := js.Global().Get("Object").New()
	headers.Set("Cache-Control", "private, no-store, max-age=0")
	headers.Set("Content-Type", "application/json; charset=utf-8")
	headers.Set("Expires", "0")
	headers.Set("Pragma", "no-cache")
	headers.Set("Referrer-Policy", "no-referrer")
	headers.Set("X-Content-Type-Options", "nosniff")
	headers.Set("X-Robots-Tag", "noindex, nofollow, noarchive")
	if origin := headerValue(request, "origin"); origin != "" && origin == env.Get("WEB_ORIGIN").String() {
		headers.Set("Access-Control-Allow-Origin", origin)
		headers.Set("Access-Control-Allow-Methods", "GET, PATCH, POST, OPTIONS")
		headers.Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type")
		headers.Set("Access-Control-Max-Age", "600")
		headers.Set("Vary", "Origin")
	}
	options := js.Global().Get("Object").New()
	options.Set("status", http.StatusServiceUnavailable)
	options.Set("headers", headers)
	return js.Global().Get("Response").New(`{"error":"temporarily_unavailable"}`, options)
}
