export interface ManagementSpace {
  id: string;
  name: string;
}

export interface Person {
  id: string;
  name: string;
}

export interface WorkPeriod {
  startTime: string;
  endTime: string;
  breakStartTime?: string;
  breakEndTime?: string;
}

export interface PatternDay {
  weekday: number;
  state: "undefined" | "day_off" | "work_period";
  workPeriod?: WorkPeriod;
}

export interface WeeklyPattern {
  id: string;
  effectiveFrom: string;
  weekdays: PatternDay[];
}

export interface WeekParticipation {
  id: string;
  person: Person;
  startDate: string;
  endDate?: string;
  patternVersions: WeeklyPattern[];
  dateExceptions?: DateException[];
}

export interface DateException {
  date: string;
  state: "vacation" | "absence" | "medical_leave";
}

export interface Schedule {
  id: string;
  name: string;
  timeZone: string;
  managementSpace: ManagementSpace;
  participations?: WeekParticipation[];
}

export interface ScheduleDay {
  date: string;
  weekday: number;
  state: "outside_participation" | "undefined" | "day_off" | "work_period" | "vacation" | "absence" | "medical_leave";
  workPeriod?: WorkPeriod;
}

export interface PersonWeek {
  participationId: string;
  person: Person;
  days: ScheduleDay[];
}

export interface ScheduleWeek {
  scheduleId: string;
  weekStart: string;
  weekEnd: string;
  timeZone: string;
  isCurrentWeek: boolean;
  isPastWeek: boolean;
  people: PersonWeek[];
}

export interface ManagementSpaceView {
  managementSpace: ManagementSpace;
  schedules: Schedule[];
  people: Person[];
}
