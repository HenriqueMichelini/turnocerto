package schedule_test

import (
	"testing"
	"time"

	"github.com/HenriqueMichelini/turnocerto/backend/internal/schedule"
)

func TestScheduleWeekDerivesDatedPatternsInsideInclusiveParticipation(t *testing.T) {
	pattern := func(id, effectiveFrom string, weekdayStates map[int]string) schedule.WeeklyPattern {
		weekdays := make([]schedule.PatternDay, 7)
		for weekday := 1; weekday <= 7; weekday++ {
			state := "undefined"
			if configured, exists := weekdayStates[weekday]; exists {
				state = configured
			}
			var period *schedule.WorkPeriod
			if state == schedule.DayStateWorkPeriod {
				period = &schedule.WorkPeriod{StartTime: "09:00", EndTime: "17:00"}
			}
			weekdays[weekday-1] = schedule.PatternDay{Weekday: weekday, State: state, WorkPeriod: period}
		}
		return schedule.WeeklyPattern{ID: id, EffectiveFrom: effectiveFrom, Weekdays: weekdays}
	}
	participation := schedule.WeekParticipation{
		ID:                 "participation-1",
		Person:             schedule.Person{ID: "person-1", Name: "Ana"},
		ParticipationStart: "2026-09-10",
		ParticipationEnd:   stringPointer("2026-09-15"),
		PatternVersions: []schedule.WeeklyPattern{
			pattern("initial", "2026-09-07", map[int]string{4: "work_period"}),
			pattern("next", "2026-09-14", map[int]string{1: "day_off", 2: "day_off"}),
		},
	}
	calendar := schedule.Schedule{ID: "schedule-1", TimeZone: "America/Sao_Paulo"}
	now := time.Date(2026, 9, 16, 12, 0, 0, 0, time.UTC)

	firstWeek, err := schedule.DeriveScheduleWeek(calendar, "2026-09-07", []schedule.WeekParticipation{participation}, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(firstWeek.People[0].Days); got != 7 {
		t.Fatalf("first week has %d days, want Monday through Sunday (7)", got)
	}
	if got := firstWeek.People[0].Days[0].State; got != "outside_participation" {
		t.Fatalf("Monday before participation = %q, want outside_participation", got)
	}
	if got := firstWeek.People[0].Days[3].State; got != "work_period" {
		t.Fatalf("Thursday initial pattern = %q, want work_period", got)
	}
	if !firstWeek.IsPastWeek || firstWeek.IsCurrentWeek {
		t.Fatalf("week classification = current %v, past %v; want past", firstWeek.IsCurrentWeek, firstWeek.IsPastWeek)
	}

	secondWeek, err := schedule.DeriveScheduleWeek(calendar, "2026-09-14", []schedule.WeekParticipation{participation}, now)
	if err != nil {
		t.Fatal(err)
	}
	if got := secondWeek.People[0].Days[0].State; got != "day_off" {
		t.Fatalf("Monday after pattern change = %q, want day_off", got)
	}
	if got := secondWeek.People[0].Days[1].State; got != "day_off" {
		t.Fatalf("Tuesday on inclusive participation end = %q, want day_off", got)
	}
	if got := secondWeek.People[0].Days[2].State; got != "outside_participation" {
		t.Fatalf("Wednesday after participation end = %q, want outside_participation", got)
	}
	if !secondWeek.IsCurrentWeek || secondWeek.IsPastWeek {
		t.Fatalf("week classification = current %v, past %v; want current", secondWeek.IsCurrentWeek, secondWeek.IsPastWeek)
	}
}

func TestScheduleWeekCurrentBoundaryUsesScheduleTimeZone(t *testing.T) {
	now := time.Date(2026, 9, 28, 0, 30, 0, 0, time.UTC)
	week, err := schedule.DeriveScheduleWeek(schedule.Schedule{ID: "schedule-1", TimeZone: "America/Los_Angeles"}, "2026-09-21", nil, now)
	if err != nil {
		t.Fatal(err)
	}
	if !week.IsCurrentWeek || week.IsPastWeek {
		t.Fatalf("week classification in Los Angeles = current %v, past %v; local date is still Sunday", week.IsCurrentWeek, week.IsPastWeek)
	}
}

func TestScheduleWeekAppliesDateExceptionsOverWeeklyPattern(t *testing.T) {
	participation := schedule.WeekParticipation{
		ID:                 "participation-1",
		Person:             schedule.Person{ID: "person-1", Name: "Ana"},
		ParticipationStart: "2026-09-07",
		ParticipationEnd:   stringPointer("2026-09-13"),
		PatternVersions: []schedule.WeeklyPattern{{
			ID:            "pattern-1",
			EffectiveFrom: "2026-09-07",
			Weekdays: []schedule.PatternDay{{Weekday: 1, State: schedule.DayStateDayOff},
				{Weekday: 2, State: schedule.DayStateDayOff}, {Weekday: 3, State: schedule.DayStateDayOff},
				{Weekday: 4, State: schedule.DayStateDayOff}, {Weekday: 5, State: schedule.DayStateDayOff},
				{Weekday: 6, State: schedule.DayStateDayOff}, {Weekday: 7, State: schedule.DayStateDayOff}},
		}},
		DateExceptions: []schedule.DateException{
			{Date: "2026-09-11", State: schedule.DayStateVacation},
			{Date: "2026-09-12", State: schedule.DayStateWorkPeriod, WorkPeriod: &schedule.WorkPeriod{StartTime: "10:00", EndTime: "14:00"}},
		},
	}
	week, err := schedule.DeriveScheduleWeek(schedule.Schedule{ID: "schedule-1", TimeZone: "UTC"}, "2026-09-07", []schedule.WeekParticipation{participation}, time.Date(2026, 9, 9, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if got := week.People[0].Days[4].State; got != schedule.DayStateVacation {
		t.Fatalf("Friday exception state = %q, want vacation", got)
	}
	if got := week.People[0].Days[3].State; got != schedule.DayStateDayOff {
		t.Fatalf("Thursday without exception = %q, want day off", got)
	}
	if got := week.People[0].Days[5].State; got != schedule.DayStateWorkPeriod {
		t.Fatalf("Saturday work exception = %q, want work_period", got)
	}
	if got := week.People[0].Days[5].WorkPeriod.EndTime; got != "14:00" {
		t.Fatalf("Saturday work exception ends at %q, want 14:00", got)
	}
}

func TestScheduleWeekRejectsNonMondayAndUnknownTimeZone(t *testing.T) {
	for _, test := range []struct {
		name     string
		schedule schedule.Schedule
		start    string
	}{
		{name: "not a Monday", schedule: schedule.Schedule{TimeZone: "UTC"}, start: "2026-09-08"},
		{name: "unknown time zone", schedule: schedule.Schedule{TimeZone: "Mars/Olympus"}, start: "2026-09-07"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := schedule.DeriveScheduleWeek(test.schedule, test.start, nil, time.Now()); err == nil {
				t.Fatal("DeriveScheduleWeek succeeded, want an error")
			}
		})
	}
}

func stringPointer(value string) *string { return &value }
