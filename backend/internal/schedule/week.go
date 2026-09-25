package schedule

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"
)

const (
	DayStateOutsideParticipation = "outside_participation"
	DayStateUndefined            = "undefined"
	DayStateDayOff               = "day_off"
	DayStateWorkPeriod           = "work_period"
	DayStateVacation             = "vacation"
	DayStateAbsence              = "absence"
	DayStateMedicalLeave         = "medical_leave"
)

var ErrInvalidScheduleWeek = errors.New("invalid schedule week")
var ErrStaleScheduleEdit = errors.New("schedule edit is based on a stale version")

type Person struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type WorkPeriod struct {
	StartTime      string `json:"startTime"`
	EndTime        string `json:"endTime"`
	BreakStartTime string `json:"breakStartTime,omitempty"`
	BreakEndTime   string `json:"breakEndTime,omitempty"`
}

type PatternDay struct {
	Weekday    int         `json:"weekday"`
	State      string      `json:"state"`
	WorkPeriod *WorkPeriod `json:"workPeriod,omitempty"`
}

type WeeklyPattern struct {
	ID            string       `json:"id"`
	EffectiveFrom string       `json:"effectiveFrom"`
	Weekdays      []PatternDay `json:"weekdays"`
}

type WeekParticipation struct {
	ID                 string          `json:"id"`
	Person             Person          `json:"person"`
	ParticipationStart string          `json:"startDate"`
	ParticipationEnd   *string         `json:"endDate,omitempty"`
	PatternVersions    []WeeklyPattern `json:"patternVersions"`
	DateExceptions     []DateException `json:"dateExceptions,omitempty"`
}

type DateException struct {
	ID         string      `json:"-"`
	Date       string      `json:"date"`
	State      string      `json:"state"`
	WorkPeriod *WorkPeriod `json:"workPeriod,omitempty"`
}

const (
	ScheduleEditOnce      = "once"
	ScheduleEditRecurring = "recurring"
)

type ScheduleEdit struct {
	Revision               string          `json:"revision"`
	WeekStart              string          `json:"weekStart"`
	Mode                   string          `json:"mode"`
	Dates                  []DateException `json:"dates,omitempty"`
	RemoveDates            []string        `json:"removeDates,omitempty"`
	Weekdays               []PatternDay    `json:"weekdays,omitempty"`
	RemoveFutureExceptions bool            `json:"removeFutureExceptions,omitempty"`
	PatternID              string          `json:"-"`
}

type ScheduleDay struct {
	Date              string      `json:"date"`
	Weekday           int         `json:"weekday"`
	State             string      `json:"state"`
	WorkPeriod        *WorkPeriod `json:"workPeriod,omitempty"`
	PatternState      string      `json:"patternState,omitempty"`
	PatternWorkPeriod *WorkPeriod `json:"patternWorkPeriod,omitempty"`
	HasException      bool        `json:"hasException"`
}

type PersonWeek struct {
	ParticipationID string        `json:"participationId"`
	Person          Person        `json:"person"`
	Days            []ScheduleDay `json:"days"`
}

type ScheduleWeek struct {
	ScheduleID    string       `json:"scheduleId"`
	Revision      string       `json:"revision"`
	WeekStart     string       `json:"weekStart"`
	WeekEnd       string       `json:"weekEnd"`
	TimeZone      string       `json:"timeZone"`
	IsCurrentWeek bool         `json:"isCurrentWeek"`
	IsPastWeek    bool         `json:"isPastWeek"`
	People        []PersonWeek `json:"people"`
}

// DeriveScheduleWeek builds one Monday-to-Sunday view from participation
// ranges and the version of each recurring pattern effective on each date.
func DeriveScheduleWeek(calendar Schedule, weekStart string, participations []WeekParticipation, now time.Time) (ScheduleWeek, error) {
	start, err := parseCalendarDate(weekStart)
	if err != nil || start.Weekday() != time.Monday {
		return ScheduleWeek{}, fmt.Errorf("%w: week start must be a Monday in YYYY-MM-DD format", ErrInvalidScheduleWeek)
	}
	location, err := time.LoadLocation(calendar.TimeZone)
	if err != nil {
		return ScheduleWeek{}, fmt.Errorf("%w: unknown schedule time zone", ErrInvalidScheduleWeek)
	}
	end := start.AddDate(0, 0, 6)
	localNow := now.In(location)
	localDate := localNow.Format("2006-01-02")
	weekStartDate := start.Format("2006-01-02")
	weekEndDate := end.Format("2006-01-02")
	week := ScheduleWeek{
		ScheduleID:    calendar.ID,
		Revision:      calendar.Revision,
		WeekStart:     weekStartDate,
		WeekEnd:       weekEndDate,
		TimeZone:      calendar.TimeZone,
		IsCurrentWeek: localDate >= weekStartDate && localDate <= weekEndDate,
		IsPastWeek:    localDate > weekEndDate,
		People:        make([]PersonWeek, 0, len(participations)),
	}

	for _, participation := range participations {
		personWeek, intersects, err := derivePersonWeek(participation, start)
		if err != nil {
			return ScheduleWeek{}, err
		}
		if intersects {
			week.People = append(week.People, personWeek)
		}
	}
	sort.SliceStable(week.People, func(i, j int) bool {
		return week.People[i].Person.Name < week.People[j].Person.Name
	})
	return week, nil
}

func derivePersonWeek(participation WeekParticipation, weekStart time.Time) (PersonWeek, bool, error) {
	participationStart, err := parseCalendarDate(participation.ParticipationStart)
	if err != nil {
		return PersonWeek{}, false, fmt.Errorf("%w: invalid participation start date", ErrInvalidScheduleWeek)
	}
	var participationEnd time.Time
	if participation.ParticipationEnd != nil {
		participationEnd, err = parseCalendarDate(*participation.ParticipationEnd)
		if err != nil || participationEnd.Before(participationStart) {
			return PersonWeek{}, false, fmt.Errorf("%w: invalid participation end date", ErrInvalidScheduleWeek)
		}
	}
	weekEnd := weekStart.AddDate(0, 0, 6)
	if participationStart.After(weekEnd) || (participation.ParticipationEnd != nil && participationEnd.Before(weekStart)) {
		return PersonWeek{}, false, nil
	}

	patterns := make([]datedPattern, 0, len(participation.PatternVersions))
	for _, version := range participation.PatternVersions {
		if err := validatePatternVersion(version); err != nil {
			return PersonWeek{}, false, err
		}
		effective, _ := parseCalendarDate(version.EffectiveFrom)
		patterns = append(patterns, datedPattern{start: effective, pattern: version})
	}
	sort.Slice(patterns, func(i, j int) bool { return patterns[i].start.Before(patterns[j].start) })
	for index := 1; index < len(patterns); index++ {
		if patterns[index-1].start.Equal(patterns[index].start) {
			return PersonWeek{}, false, fmt.Errorf("%w: duplicate pattern version date", ErrInvalidScheduleWeek)
		}
	}
	exceptions := make(map[string]string, len(participation.DateExceptions))
	for _, exception := range participation.DateExceptions {
		date, _ := parseCalendarDate(exception.Date)
		if err := ValidateDateException(exception); err != nil || date.Before(participationStart) || (participation.ParticipationEnd != nil && date.After(participationEnd)) {
			return PersonWeek{}, false, fmt.Errorf("%w: invalid date-specific special state", ErrInvalidScheduleWeek)
		}
		if _, exists := exceptions[exception.Date]; exists {
			return PersonWeek{}, false, fmt.Errorf("%w: duplicate date-specific special state", ErrInvalidScheduleWeek)
		}
		exceptions[exception.Date] = exception.State
	}

	personWeek := PersonWeek{
		ParticipationID: participation.ID,
		Person:          participation.Person,
		Days:            make([]ScheduleDay, 7),
	}
	for offset := 0; offset < 7; offset++ {
		date := weekStart.AddDate(0, 0, offset)
		day := ScheduleDay{Date: date.Format("2006-01-02"), Weekday: offset + 1, State: DayStateUndefined}
		if date.Before(participationStart) || (participation.ParticipationEnd != nil && date.After(participationEnd)) {
			day.State = DayStateOutsideParticipation
			personWeek.Days[offset] = day
			continue
		}
		for index := len(patterns) - 1; index >= 0; index-- {
			if !patterns[index].start.After(date) {
				patternDay := patternDayForWeekday(patterns[index].pattern, offset+1)
				day.State = patternDay.State
				day.WorkPeriod = patternDay.WorkPeriod
				day.PatternState = patternDay.State
				day.PatternWorkPeriod = patternDay.WorkPeriod
				break
			}
		}
		if state, exists := exceptions[day.Date]; exists {
			day.State = state
			day.WorkPeriod = exceptionWorkPeriod(participation.DateExceptions, day.Date)
			day.HasException = true
		}
		personWeek.Days[offset] = day
	}
	return personWeek, true, nil
}

func ValidateDateException(exception DateException) error {
	if _, err := parseCalendarDate(exception.Date); err != nil {
		return fmt.Errorf("%w: invalid date-specific special state", ErrInvalidScheduleWeek)
	}
	switch exception.State {
	case DayStateUndefined, DayStateDayOff, DayStateVacation, DayStateAbsence, DayStateMedicalLeave:
		if exception.WorkPeriod != nil {
			return fmt.Errorf("%w: non-work exceptions cannot include a work period", ErrInvalidScheduleWeek)
		}
	case DayStateWorkPeriod:
		if exception.WorkPeriod == nil || validateWorkPeriod(*exception.WorkPeriod) != nil {
			return fmt.Errorf("%w: work exceptions require valid work period times", ErrInvalidScheduleWeek)
		}
	default:
		return fmt.Errorf("%w: unsupported date-specific state", ErrInvalidScheduleWeek)
	}
	return nil
}

func exceptionWorkPeriod(exceptions []DateException, date string) *WorkPeriod {
	for _, exception := range exceptions {
		if exception.Date == date {
			return exception.WorkPeriod
		}
	}
	return nil
}

// ValidateScheduleEdit keeps a point correction inside the opened week and
// allows recurring changes only from the current or a future schedule week.
func ValidateScheduleEdit(calendar Schedule, participation WeekParticipation, edit ScheduleEdit, now time.Time) error {
	if strings.TrimSpace(edit.Revision) == "" || len(edit.Revision) > 128 {
		return fmt.Errorf("%w: missing edit revision", ErrInvalidScheduleWeek)
	}
	weekStart, err := parseCalendarDate(edit.WeekStart)
	if err != nil || weekStart.Weekday() != time.Monday {
		return fmt.Errorf("%w: edit week must start on Monday", ErrInvalidScheduleWeek)
	}
	weekEnd := weekStart.AddDate(0, 0, 6)
	participationStart, err := parseCalendarDate(participation.ParticipationStart)
	if err != nil {
		return fmt.Errorf("%w: invalid participation start date", ErrInvalidScheduleWeek)
	}
	var participationEnd time.Time
	if participation.ParticipationEnd != nil {
		participationEnd, err = parseCalendarDate(*participation.ParticipationEnd)
		if err != nil || participationEnd.Before(participationStart) {
			return fmt.Errorf("%w: invalid participation end date", ErrInvalidScheduleWeek)
		}
	}

	switch edit.Mode {
	case ScheduleEditOnce:
		if len(edit.Dates)+len(edit.RemoveDates) == 0 || len(edit.Dates)+len(edit.RemoveDates) > 7 || len(edit.Weekdays) != 0 || edit.RemoveFutureExceptions {
			return fmt.Errorf("%w: invalid one-time edit", ErrInvalidScheduleWeek)
		}
		seen := make(map[string]struct{}, len(edit.Dates))
		for _, exception := range edit.Dates {
			date, parseErr := parseCalendarDate(exception.Date)
			if parseErr != nil || date.Before(weekStart) || date.After(weekEnd) || date.Before(participationStart) || (participation.ParticipationEnd != nil && date.After(participationEnd)) || ValidateDateException(exception) != nil {
				return fmt.Errorf("%w: invalid one-time edit date", ErrInvalidScheduleWeek)
			}
			if _, exists := seen[exception.Date]; exists {
				return fmt.Errorf("%w: duplicate one-time edit date", ErrInvalidScheduleWeek)
			}
			seen[exception.Date] = struct{}{}
		}
		for _, value := range edit.RemoveDates {
			date, parseErr := parseCalendarDate(value)
			if parseErr != nil || date.Before(weekStart) || date.After(weekEnd) || date.Before(participationStart) || (participation.ParticipationEnd != nil && date.After(participationEnd)) {
				return fmt.Errorf("%w: invalid one-time exception removal date", ErrInvalidScheduleWeek)
			}
			if _, exists := seen[value]; exists {
				return fmt.Errorf("%w: duplicate one-time edit date", ErrInvalidScheduleWeek)
			}
			seen[value] = struct{}{}
		}
	case ScheduleEditRecurring:
		if len(edit.Dates) != 0 || len(edit.RemoveDates) != 0 || len(edit.Weekdays) == 0 || len(edit.Weekdays) > 7 {
			return fmt.Errorf("%w: invalid recurring edit", ErrInvalidScheduleWeek)
		}
		if weekEnd.Before(participationStart) || (participation.ParticipationEnd != nil && participationEnd.Before(weekStart)) {
			return fmt.Errorf("%w: recurring edit week is outside participation", ErrInvalidScheduleWeek)
		}
		location, loadErr := time.LoadLocation(calendar.TimeZone)
		if loadErr != nil {
			return fmt.Errorf("%w: unknown schedule time zone", ErrInvalidScheduleWeek)
		}
		localNow := now.In(location)
		currentWeekStart := localNow.AddDate(0, 0, -((int(localNow.Weekday()) + 6) % 7)).Format("2006-01-02")
		if edit.WeekStart < currentWeekStart {
			return fmt.Errorf("%w: recurring edits cannot start in a past week", ErrInvalidScheduleWeek)
		}
		seen := [8]bool{}
		for _, day := range edit.Weekdays {
			if day.Weekday < 1 || day.Weekday > 7 || seen[day.Weekday] {
				return fmt.Errorf("%w: recurring edit weekdays must be unique", ErrInvalidScheduleWeek)
			}
			seen[day.Weekday] = true
			if day.State != DayStateUndefined && day.State != DayStateDayOff && day.State != DayStateWorkPeriod {
				return fmt.Errorf("%w: date-specific states cannot recur", ErrInvalidScheduleWeek)
			}
			if day.State == DayStateWorkPeriod {
				if day.WorkPeriod == nil || validateWorkPeriod(*day.WorkPeriod) != nil {
					return fmt.Errorf("%w: recurring work days require valid work period times", ErrInvalidScheduleWeek)
				}
			} else if day.WorkPeriod != nil {
				return fmt.Errorf("%w: non-work days cannot include a work period", ErrInvalidScheduleWeek)
			}
		}
	default:
		return fmt.Errorf("%w: unknown edit mode", ErrInvalidScheduleWeek)
	}
	return nil
}

// FutureExceptionStartDate keeps elapsed dates in an open current week intact
// when a recurring pattern edit removes future exceptions.
func FutureExceptionStartDate(calendar Schedule, weekStart string, now time.Time) (string, error) {
	start, err := parseCalendarDate(weekStart)
	if err != nil || start.Weekday() != time.Monday {
		return "", fmt.Errorf("%w: edit week must start on Monday", ErrInvalidScheduleWeek)
	}
	location, err := time.LoadLocation(calendar.TimeZone)
	if err != nil {
		return "", fmt.Errorf("%w: unknown schedule time zone", ErrInvalidScheduleWeek)
	}
	localTomorrow := now.In(location).AddDate(0, 0, 1).Format("2006-01-02")
	if localTomorrow > weekStart {
		return localTomorrow, nil
	}
	return weekStart, nil
}

type datedPattern struct {
	start   time.Time
	pattern WeeklyPattern
}

func validateWeeklyPattern(pattern WeeklyPattern) error {
	if len(pattern.Weekdays) != 7 {
		return fmt.Errorf("%w: weekly patterns must define seven weekdays", ErrInvalidScheduleWeek)
	}
	seen := [8]bool{}
	for _, day := range pattern.Weekdays {
		if day.Weekday < 1 || day.Weekday > 7 || seen[day.Weekday] {
			return fmt.Errorf("%w: weekly pattern weekday must be unique and between Monday and Sunday", ErrInvalidScheduleWeek)
		}
		seen[day.Weekday] = true
		switch day.State {
		case DayStateUndefined, DayStateDayOff:
			if day.WorkPeriod != nil {
				return fmt.Errorf("%w: non-work days cannot include a work period", ErrInvalidScheduleWeek)
			}
		case DayStateWorkPeriod:
			if day.WorkPeriod == nil || validateWorkPeriod(*day.WorkPeriod) != nil {
				return fmt.Errorf("%w: work days require valid work period times", ErrInvalidScheduleWeek)
			}
		default:
			return fmt.Errorf("%w: weekly pattern includes an unsupported date-specific state", ErrInvalidScheduleWeek)
		}
	}
	return nil
}

func patternDayForWeekday(pattern WeeklyPattern, weekday int) PatternDay {
	for _, day := range pattern.Weekdays {
		if day.Weekday == weekday {
			return day
		}
	}
	return PatternDay{Weekday: weekday, State: DayStateUndefined}
}

func validScheduleTimeZone(value string) bool {
	if value == "" || strings.TrimSpace(value) != value {
		return false
	}
	_, err := time.LoadLocation(value)
	return err == nil
}

func validatePatternVersion(pattern WeeklyPattern) error {
	effective, err := parseCalendarDate(pattern.EffectiveFrom)
	if err != nil || effective.Weekday() != time.Monday {
		return fmt.Errorf("%w: pattern versions must start on a Monday", ErrInvalidScheduleWeek)
	}
	return validateWeeklyPattern(pattern)
}

func validateParticipationDates(startDate string, endDate *string) error {
	start, err := parseCalendarDate(startDate)
	if err != nil {
		return fmt.Errorf("%w: invalid participation start date", ErrInvalidScheduleWeek)
	}
	if endDate != nil {
		end, err := parseCalendarDate(*endDate)
		if err != nil || end.Before(start) {
			return fmt.Errorf("%w: invalid participation end date", ErrInvalidScheduleWeek)
		}
	}
	return nil
}

func validateWorkPeriod(period WorkPeriod) error {
	start, err := parseClockMinute(period.StartTime)
	if err != nil {
		return err
	}
	end, err := parseClockMinute(period.EndTime)
	if err != nil {
		return err
	}
	if end <= start {
		end += 24 * 60
	}
	if period.BreakStartTime == "" && period.BreakEndTime == "" {
		return nil
	}
	if period.BreakStartTime == "" || period.BreakEndTime == "" {
		return errors.New("work period break requires a start and end")
	}
	breakStart, err := parseClockMinute(period.BreakStartTime)
	if err != nil {
		return err
	}
	breakEnd, err := parseClockMinute(period.BreakEndTime)
	if err != nil {
		return err
	}
	if breakStart < start {
		breakStart += 24 * 60
	}
	if breakEnd <= breakStart {
		breakEnd += 24 * 60
	}
	if breakStart < start || breakEnd > end {
		return errors.New("work period break must be inside the work period")
	}
	return nil
}

func parseClockMinute(value string) (int, error) {
	parsed, err := time.Parse("15:04", value)
	if err != nil || parsed.Format("15:04") != value {
		return 0, errors.New("clock time must use HH:MM")
	}
	return parsed.Hour()*60 + parsed.Minute(), nil
}

func parseCalendarDate(value string) (time.Time, error) {
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil || parsed.Format("2006-01-02") != value {
		return time.Time{}, errors.New("date must use YYYY-MM-DD")
	}
	return parsed, nil
}
