package schedule_test

import (
	"errors"
	"testing"
	"time"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

func TestRecurringEditsUseTheOpenedCurrentMondayAndPastWeeksAllowOnlyPointEdits(t *testing.T) {
	location, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	calendar := schedule.Schedule{ID: "schedule", TimeZone: "America/Sao_Paulo"}
	participation := schedule.WeekParticipation{
		ID:                 "participation",
		ParticipationStart: "2026-08-31",
		PatternVersions: []schedule.WeeklyPattern{{
			EffectiveFrom: "2026-08-31",
			Weekdays: []schedule.PatternDay{
				{Weekday: 1, State: schedule.DayStateUndefined},
				{Weekday: 2, State: schedule.DayStateUndefined},
				{Weekday: 3, State: schedule.DayStateUndefined},
				{Weekday: 4, State: schedule.DayStateUndefined},
				{Weekday: 5, State: schedule.DayStateUndefined},
				{Weekday: 6, State: schedule.DayStateUndefined},
				{Weekday: 7, State: schedule.DayStateUndefined},
			},
		}},
	}
	now := time.Date(2026, time.September, 25, 12, 0, 0, 0, location)
	currentWeekEdit := schedule.ScheduleEdit{
		Revision:  "revision-1",
		WeekStart: "2026-09-21",
		Mode:      schedule.ScheduleEditRecurring,
		Weekdays:  []schedule.PatternDay{{Weekday: 1, State: schedule.DayStateDayOff}},
	}
	if err := schedule.ValidateScheduleEdit(calendar, participation, currentWeekEdit, now); err != nil {
		t.Fatalf("recurring edit opened in the current week was rejected: %v", err)
	}

	pastWeekEdit := currentWeekEdit
	pastWeekEdit.WeekStart = "2026-09-14"
	if err := schedule.ValidateScheduleEdit(calendar, participation, pastWeekEdit, now); !errors.Is(err, schedule.ErrInvalidScheduleWeek) {
		t.Fatalf("recurring edit opened in a past week error = %v, want ErrInvalidScheduleWeek", err)
	}

	pastCorrection := schedule.ScheduleEdit{
		Revision:  "revision-1",
		WeekStart: "2026-09-14",
		Mode:      schedule.ScheduleEditOnce,
		Dates:     []schedule.DateException{{Date: "2026-09-18", State: schedule.DayStateAbsence}},
	}
	if err := schedule.ValidateScheduleEdit(calendar, participation, pastCorrection, now); err != nil {
		t.Fatalf("one-time correction to a past week was rejected: %v", err)
	}

	dateSpecificPattern := currentWeekEdit
	dateSpecificPattern.Weekdays = []schedule.PatternDay{{Weekday: 1, State: schedule.DayStateVacation}}
	if err := schedule.ValidateScheduleEdit(calendar, participation, dateSpecificPattern, now); !errors.Is(err, schedule.ErrInvalidScheduleWeek) {
		t.Fatalf("recurring date-specific state error = %v, want ErrInvalidScheduleWeek", err)
	}
}

func TestRecurringEditMustIntersectParticipation(t *testing.T) {
	calendar := schedule.Schedule{ID: "schedule", TimeZone: "UTC"}
	participation := schedule.WeekParticipation{
		ID:                 "participation",
		ParticipationStart: "2026-09-21",
		ParticipationEnd:   pointerTo("2026-09-25"),
	}
	edit := schedule.ScheduleEdit{
		Revision:  "revision-1",
		WeekStart: "2026-09-28",
		Mode:      schedule.ScheduleEditRecurring,
		Weekdays:  []schedule.PatternDay{{Weekday: 1, State: schedule.DayStateDayOff}},
	}
	if err := schedule.ValidateScheduleEdit(calendar, participation, edit, time.Date(2026, 9, 21, 12, 0, 0, 0, time.UTC)); !errors.Is(err, schedule.ErrInvalidScheduleWeek) {
		t.Fatalf("recurring edit outside participation error = %v, want ErrInvalidScheduleWeek", err)
	}
}

func pointerTo(value string) *string { return &value }

func TestCurrentWeekRecurringVersionAlsoChangesElapsedDaysSinceMonday(t *testing.T) {
	weekday := func(mondayState string) []schedule.PatternDay {
		days := make([]schedule.PatternDay, 7)
		for index := range days {
			days[index] = schedule.PatternDay{Weekday: index + 1, State: schedule.DayStateUndefined}
		}
		days[0].State = mondayState
		return days
	}
	participation := schedule.WeekParticipation{
		ID:                 "participation",
		Person:             schedule.Person{ID: "person", Name: "Ana"},
		ParticipationStart: "2026-09-14",
		PatternVersions: []schedule.WeeklyPattern{
			{EffectiveFrom: "2026-09-14", Weekdays: weekday(schedule.DayStateUndefined)},
			{EffectiveFrom: "2026-09-21", Weekdays: weekday(schedule.DayStateDayOff)},
		},
	}
	week, err := schedule.DeriveScheduleWeek(
		schedule.Schedule{ID: "schedule", TimeZone: "America/Sao_Paulo"},
		"2026-09-21",
		[]schedule.WeekParticipation{participation},
		time.Date(2026, time.September, 25, 12, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatal(err)
	}
	if !week.IsCurrentWeek {
		t.Fatal("the opened Monday-to-Sunday week was not classified as current")
	}
	if got := week.People[0].Days[0].State; got != schedule.DayStateDayOff {
		t.Fatalf("elapsed Monday after a current-week recurring edit = %q, want day_off", got)
	}
}

func TestPointEditsCanRemoveAnExceptionAndLimitRecurringCleanupToFutureDates(t *testing.T) {
	location, err := time.LoadLocation("America/Sao_Paulo")
	if err != nil {
		t.Fatal(err)
	}
	calendar := schedule.Schedule{ID: "schedule", TimeZone: "America/Sao_Paulo"}
	participation := schedule.WeekParticipation{ID: "participation", ParticipationStart: "2026-09-01"}
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, location)
	pointRemoval := schedule.ScheduleEdit{
		Revision:    "revision-1",
		WeekStart:   "2026-09-21",
		Mode:        schedule.ScheduleEditOnce,
		RemoveDates: []string{"2026-09-24"},
	}
	if err := schedule.ValidateScheduleEdit(calendar, participation, pointRemoval, now); err != nil {
		t.Fatalf("removing a selected date exception was rejected: %v", err)
	}

	cutoff, err := schedule.FutureExceptionStartDate(calendar, "2026-09-21", now)
	if err != nil {
		t.Fatal(err)
	}
	if cutoff != "2026-09-26" {
		t.Fatalf("current-week future exception cutoff = %q, want tomorrow in schedule time zone", cutoff)
	}
	futureWeekCutoff, err := schedule.FutureExceptionStartDate(calendar, "2026-09-28", now)
	if err != nil {
		t.Fatal(err)
	}
	if futureWeekCutoff != "2026-09-28" {
		t.Fatalf("future-week exception cutoff = %q, want opened Monday", futureWeekCutoff)
	}
	tooEarly := pointRemoval
	tooEarly.RemoveDates = []string{"2026-09-20"}
	if err := schedule.ValidateScheduleEdit(calendar, participation, tooEarly, now); !errors.Is(err, schedule.ErrInvalidScheduleWeek) {
		t.Fatalf("point removal outside opened week error = %v, want ErrInvalidScheduleWeek", err)
	}
}
