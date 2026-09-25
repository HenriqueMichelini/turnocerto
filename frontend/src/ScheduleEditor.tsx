import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { DateException, PatternDay, Person, Schedule, ScheduleWeek, WeekParticipation } from "./schedule-types";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";
const weekdayNames = ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"];
const brazilianTimeZones = [
  "America/Araguaina",
  "America/Bahia",
  "America/Belem",
  "America/Boa_Vista",
  "America/Campo_Grande",
  "America/Cuiaba",
  "America/Fortaleza",
  "America/Maceio",
  "America/Manaus",
  "America/Noronha",
  "America/Porto_Velho",
  "America/Recife",
  "America/Rio_Branco",
  "America/Santarem",
  "America/Sao_Paulo",
];

interface Props {
  spaceID: string;
  managementToken: string;
  schedules: Schedule[];
  people: Person[];
  selectedSchedule: Schedule;
  onSelectSchedule(schedule: Schedule): void;
  onScheduleCreated(schedule: Schedule): void;
  onScheduleUpdated(schedule: Schedule): void;
  onPersonCreated(person: Person): void;
}

interface PatternDayState {
  state: PatternDay["state"];
  startTime: string;
  endTime: string;
}

const emptyPattern = (): PatternDayState[] => weekdayNames.map(() => ({
  state: "undefined",
  startTime: "09:00",
  endTime: "17:00",
}));

export function ScheduleEditor({
  spaceID,
  managementToken,
  schedules,
  people,
  selectedSchedule,
  onSelectSchedule,
  onScheduleCreated,
  onScheduleUpdated,
  onPersonCreated,
}: Props) {
  const [weekStart, setWeekStart] = useState(() => mondayInTimeZone(selectedSchedule.timeZone, new Date()));
  const [week, setWeek] = useState<ScheduleWeek | null>(null);
  const [isLoadingWeek, setIsLoadingWeek] = useState(true);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [timeZone, setTimeZone] = useState(selectedSchedule.timeZone);
  const [isSavingTimeZone, setIsSavingTimeZone] = useState(false);
  const [newScheduleName, setNewScheduleName] = useState("");
  const [newScheduleTimeZone, setNewScheduleTimeZone] = useState(selectedSchedule.timeZone);
  const [isCreatingSchedule, setIsCreatingSchedule] = useState(false);
  const [personName, setPersonName] = useState("");
  const [isCreatingPerson, setIsCreatingPerson] = useState(false);
  const [selectedPersonID, setSelectedPersonID] = useState(people[0]?.id ?? "");
  const [recentParticipation, setRecentParticipation] = useState<WeekParticipation | null>(null);
  const [exceptionParticipationID, setExceptionParticipationID] = useState(selectedSchedule.participations?.[0]?.id ?? "");
  const [exceptionDate, setExceptionDate] = useState("");
  const [exceptionState, setExceptionState] = useState<DateException["state"]>("vacation");
  const [isSavingException, setIsSavingException] = useState(false);
  const [startDate, setStartDate] = useState(() => dateInTimeZone(selectedSchedule.timeZone, new Date()));
  const [endDate, setEndDate] = useState("");
  const [pattern, setPattern] = useState<PatternDayState[]>(emptyPattern);
  const [isAddingParticipation, setIsAddingParticipation] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setTimeZone(selectedSchedule.timeZone);
    setNewScheduleTimeZone(selectedSchedule.timeZone);
    setWeekStart(mondayInTimeZone(selectedSchedule.timeZone, new Date()));
    setStartDate(dateInTimeZone(selectedSchedule.timeZone, new Date()));
    setRecentParticipation(null);
    setExceptionParticipationID(selectedSchedule.participations?.[0]?.id ?? "");
    setExceptionDate("");
    setWeek(null);
  }, [selectedSchedule.id, selectedSchedule.timeZone, selectedSchedule.participations]);

  useEffect(() => {
    if (!people.some((person) => person.id === selectedPersonID)) {
      setSelectedPersonID(people[0]?.id ?? "");
    }
  }, [people, selectedPersonID]);

  useEffect(() => {
    let active = true;
    async function loadWeek() {
      setIsLoadingWeek(true);
      setError("");
      try {
        const response = await fetch(
          `${apiBaseUrl}/api/management-spaces/${encodeURIComponent(spaceID)}/schedules/${encodeURIComponent(selectedSchedule.id)}?weekStart=${encodeURIComponent(weekStart)}`,
          { headers: managementHeaders(managementToken, { Accept: "application/json" }) },
        );
        if (!response.ok) throw new Error("week_load_failed");
        const result = await response.json() as { week: ScheduleWeek };
        if (active) setWeek(result.week);
      } catch {
        if (active) setError("Não foi possível abrir esta semana. Tente novamente.");
      } finally {
        if (active) setIsLoadingWeek(false);
      }
    }
    void loadWeek();
    return () => {
      active = false;
    };
  }, [spaceID, managementToken, selectedSchedule.id, weekStart, reloadVersion]);

  async function saveTimeZone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSavingTimeZone(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(scheduleURL(spaceID, selectedSchedule.id), {
        method: "PATCH",
        headers: managementHeaders(managementToken, { Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify({ timeZone }),
      });
      if (!response.ok) throw new Error("time_zone_save_failed");
      const result = await response.json() as { schedule: Schedule };
      onScheduleUpdated(result.schedule);
      setMessage("Fuso horário salvo.");
    } catch {
      setError("Não foi possível salvar o fuso horário. Informe um fuso IANA válido, como America/Sao_Paulo.");
    } finally {
      setIsSavingTimeZone(false);
    }
  }

  async function createSchedule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCreatingSchedule(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/management-spaces/${encodeURIComponent(spaceID)}/schedules`, {
        method: "POST",
        headers: managementHeaders(managementToken, { Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify({ name: newScheduleName, timeZone: newScheduleTimeZone }),
      });
      if (!response.ok) throw new Error("schedule_create_failed");
      const result = await response.json() as { schedule: Schedule };
      onScheduleCreated(result.schedule);
      setNewScheduleName("");
      setMessage("Escala criada.");
    } catch {
      setError("Não foi possível criar a escala. Confira o nome e o fuso horário.");
    } finally {
      setIsCreatingSchedule(false);
    }
  }

  async function createPerson(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsCreatingPerson(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/management-spaces/${encodeURIComponent(spaceID)}/people`, {
        method: "POST",
        headers: managementHeaders(managementToken, { Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify({ name: personName }),
      });
      if (!response.ok) throw new Error("person_create_failed");
      const result = await response.json() as { person: Person };
      onPersonCreated(result.person);
      setSelectedPersonID(result.person.id);
      setPersonName("");
      setMessage("Pessoa cadastrada. Agora você pode incluí-la nesta escala.");
    } catch {
      setError("Não foi possível cadastrar a pessoa. Informe um nome com até 80 caracteres.");
    } finally {
      setIsCreatingPerson(false);
    }
  }

  async function addParticipation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedPersonID) {
      setError("Cadastre ou selecione uma pessoa antes de continuar.");
      return;
    }
    setIsAddingParticipation(true);
    setError("");
    setMessage("");
    const weekdays: PatternDay[] = pattern.map((day, index) => ({
      weekday: index + 1,
      state: day.state,
      ...(day.state === "work_period" ? { workPeriod: { startTime: day.startTime, endTime: day.endTime } } : {}),
    }));
    try {
      const response = await fetch(`${apiBaseUrl}/api/management-spaces/${encodeURIComponent(spaceID)}/schedules/${encodeURIComponent(selectedSchedule.id)}/participations`, {
        method: "POST",
        headers: managementHeaders(managementToken, { Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify({
          personId: selectedPersonID,
          startDate,
          ...(endDate ? { endDate } : {}),
          pattern: { effectiveFrom: mondayForDate(startDate), weekdays },
        }),
      });
      if (!response.ok) throw new Error("participation_create_failed");
      const result = await response.json() as { participation: WeekParticipation };
      setRecentParticipation(result.participation);
      setExceptionParticipationID(result.participation.id);
      setExceptionDate(startDate);
      setMessage("Pessoa incluída na escala e padrão recorrente salvo.");
      setPattern(emptyPattern());
      setEndDate("");
      setReloadVersion((version) => version + 1);
    } catch {
      setError("Não foi possível salvar a participação. Confira as datas e os horários das jornadas.");
    } finally {
      setIsAddingParticipation(false);
    }
  }

  async function saveDateException(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!exceptionParticipationID) {
      setError("Inclua uma pessoa nesta escala antes de registrar um estado especial.");
      return;
    }
    setIsSavingException(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/management-spaces/${encodeURIComponent(spaceID)}/schedules/${encodeURIComponent(selectedSchedule.id)}/participations/${encodeURIComponent(exceptionParticipationID)}/exceptions`, {
        method: "POST",
        headers: managementHeaders(managementToken, { Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify({ date: exceptionDate, state: exceptionState }),
      });
      if (!response.ok) throw new Error("date_exception_save_failed");
      setMessage("Estado especial salvo para esta data.");
      setReloadVersion((version) => version + 1);
    } catch {
      setError("Não foi possível salvar. Escolha uma data dentro da participação.");
    } finally {
      setIsSavingException(false);
    }
  }

  function updatePatternDay(index: number, update: Partial<PatternDayState>) {
    setPattern((current) => current.map((day, position) => position === index ? { ...day, ...update } : day));
  }

  function moveWeek(offset: number) {
    setWeekStart((current) => addCalendarDays(current, offset * 7));
  }

  return (
    <section className="schedule-editor" aria-labelledby="schedule-editor-title">
      <div className="editor-heading">
        <div>
          <p className="section-label">PROGRAMAÇÃO SEMANAL</p>
          <h2 id="schedule-editor-title">Pessoas e semanas</h2>
        </div>
        <label className="editor-schedule-picker">
          Escala
          <select
            aria-label="Escala selecionada"
            value={selectedSchedule.id}
            onChange={(event) => {
              const next = schedules.find((calendar) => calendar.id === event.target.value);
              if (next) onSelectSchedule(next);
            }}
          >
            {schedules.map((calendar) => <option key={calendar.id} value={calendar.id}>{calendar.name}</option>)}
          </select>
        </label>
      </div>

      <div className="editor-panel">
        <h3>Fuso horário da escala</h3>
        <p>O fuso define a semana atual e quando uma semana passa a ser considerada passada.</p>
        <form className="editor-inline-form" onSubmit={saveTimeZone}>
          <label htmlFor="schedule-time-zone">Fuso horário IANA</label>
          <input id="schedule-time-zone" list="brazilian-time-zones" value={timeZone} onChange={(event) => setTimeZone(event.target.value)} required />
          <datalist id="brazilian-time-zones">{brazilianTimeZones.map((zone) => <option key={zone} value={zone} />)}</datalist>
          <button type="submit" disabled={isSavingTimeZone || timeZone === selectedSchedule.timeZone}>{isSavingTimeZone ? "Salvando…" : "Salvar fuso"}</button>
        </form>
      </div>

      <details className="editor-panel">
        <summary>Criar outra escala</summary>
        <form className="editor-form editor-create-schedule" onSubmit={createSchedule}>
          <label htmlFor="new-schedule-name">Nome da escala</label>
          <input id="new-schedule-name" value={newScheduleName} onChange={(event) => setNewScheduleName(event.target.value)} maxLength={80} required />
          <label htmlFor="new-schedule-time-zone">Fuso horário</label>
          <input id="new-schedule-time-zone" list="brazilian-time-zones" value={newScheduleTimeZone} onChange={(event) => setNewScheduleTimeZone(event.target.value)} required />
          <button type="submit" disabled={isCreatingSchedule}>{isCreatingSchedule ? "Criando…" : "Criar escala"}</button>
        </form>
      </details>

      <div className="editor-panel">
        <h3>Registrar estado especial em uma data</h3>
        {(selectedSchedule.participations?.length ?? 0) === 0 && !recentParticipation ? (
          <p className="editor-empty">Inclua uma pessoa nesta escala para registrar férias, ausência ou atestado.</p>
        ) : (
          <form className="editor-inline-form" onSubmit={saveDateException}>
            <label htmlFor="exception-participation">Participação</label>
            <select id="exception-participation" value={exceptionParticipationID} onChange={(event) => setExceptionParticipationID(event.target.value)} required>
              {[...(selectedSchedule.participations ?? []), ...(recentParticipation && !selectedSchedule.participations?.some((item) => item.id === recentParticipation.id) ? [recentParticipation] : [])].map((participation) => (
                <option key={participation.id} value={participation.id}>{participation.person.name} · {participation.startDate}</option>
              ))}
            </select>
            <label htmlFor="exception-date">Data</label>
            <input id="exception-date" type="date" value={exceptionDate} onChange={(event) => setExceptionDate(event.target.value)} required />
            <label htmlFor="exception-state">Estado especial</label>
            <select id="exception-state" value={exceptionState} onChange={(event) => setExceptionState(event.target.value as DateException["state"])}>
              <option value="vacation">Férias</option>
              <option value="absence">Ausência</option>
              <option value="medical_leave">Atestado</option>
            </select>
            <button type="submit" disabled={isSavingException || !exceptionDate}>{isSavingException ? "Salvando…" : "Salvar estado especial"}</button>
          </form>
        )}
      </div>

      <div className="editor-panel">
        <h3>Cadastrar pessoa no Espaço</h3>
        <p>O cadastro é compartilhado entre as escalas deste Espaço de gestão.</p>
        <form className="editor-inline-form" onSubmit={createPerson}>
          <label htmlFor="new-person-name">Nome da pessoa</label>
          <input id="new-person-name" value={personName} onChange={(event) => setPersonName(event.target.value)} maxLength={80} required />
          <button type="submit" disabled={isCreatingPerson}>{isCreatingPerson ? "Cadastrando…" : "Cadastrar pessoa"}</button>
        </form>
      </div>

      <details className="editor-panel">
        <summary>Incluir pessoa nesta escala</summary>
        {people.length === 0 ? (
          <p className="editor-empty">Cadastre uma pessoa para definir sua participação e seu padrão semanal.</p>
        ) : (
          <form className="editor-form" onSubmit={addParticipation}>
            <div className="editor-two-columns">
              <div>
                <label htmlFor="participating-person">Pessoa</label>
                <select id="participating-person" value={selectedPersonID} onChange={(event) => setSelectedPersonID(event.target.value)} required>
                  {people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="participation-start">Início da participação</label>
                <input id="participation-start" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} required />
              </div>
              <div>
                <label htmlFor="participation-end">Fim da participação (opcional)</label>
                <input id="participation-end" type="date" value={endDate} min={startDate} onChange={(event) => setEndDate(event.target.value)} />
              </div>
            </div>

            <fieldset className="pattern-fieldset">
              <legend>Padrão semanal inicial</legend>
              <p>O padrão começa na segunda-feira da semana de início da participação. “Não definido” é diferente de “Folga”.</p>
              <div className="pattern-editor-list">
                {weekdayNames.map((weekday, index) => (
                  <div className="pattern-editor-row" key={weekday}>
                    <label htmlFor={`pattern-state-${index}`}>{weekday}</label>
                    <select id={`pattern-state-${index}`} value={pattern[index].state} onChange={(event) => updatePatternDay(index, { state: event.target.value as PatternDayState["state"] })}>
                      <option value="undefined">Não definido</option>
                      <option value="day_off">Folga</option>
                      <option value="work_period">Jornada</option>
                    </select>
                    {pattern[index].state === "work_period" && (
                      <div className="pattern-times">
                        <label htmlFor={`pattern-start-${index}`}>Início</label>
                        <input id={`pattern-start-${index}`} type="time" value={pattern[index].startTime} onChange={(event) => updatePatternDay(index, { startTime: event.target.value })} required />
                        <label htmlFor={`pattern-end-${index}`}>Fim</label>
                        <input id={`pattern-end-${index}`} type="time" value={pattern[index].endTime} onChange={(event) => updatePatternDay(index, { endTime: event.target.value })} required />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </fieldset>
            <button className="primary-button" type="submit" disabled={isAddingParticipation || !selectedPersonID}>
              {isAddingParticipation ? "Salvando participação…" : "Incluir pessoa e salvar padrão"}
            </button>
          </form>
        )}
      </details>

      <section className="editor-panel week-panel" aria-labelledby="week-title">
        <div className="week-toolbar">
          <div>
            <h3 id="week-title">Semana de {formatDate(weekStart)}</h3>
            <p>{weekStatus(week)}</p>
          </div>
          <div className="week-controls">
            <button type="button" aria-label="Semana anterior" onClick={() => moveWeek(-1)}>←</button>
            <label htmlFor="week-start">Abrir semana</label>
            <input id="week-start" type="date" value={weekStart} onChange={(event) => {
              if (event.target.value) setWeekStart(mondayForDate(event.target.value));
            }} />
            <button type="button" aria-label="Próxima semana" onClick={() => moveWeek(1)}>→</button>
          </div>
        </div>
        {isLoadingWeek ? (
          <p className="editor-empty" role="status">Abrindo a semana…</p>
        ) : week && week.people.length > 0 ? (
          <div className="calendar-scroll" aria-label="Programação da semana">
            <div className="week-grid week-header">
              {week.people[0].days.map((day, index) => <div key={day.date}>{weekdayNames[index]}<span>{formatDate(day.date)}</span></div>)}
            </div>
            {week.people.map((personWeek) => (
              <section className="person-week" key={personWeek.participationId} aria-label={`Semana de ${personWeek.person.name}`}>
                <h4>{personWeek.person.name}</h4>
                <div className="week-grid">
                  {personWeek.days.map((day) => (
                    <article className={`week-day week-day-${day.state}`} key={day.date}>
                      <span>{dayLabel(day.state)}</span>
                      {day.workPeriod && <small>{day.workPeriod.startTime}–{day.workPeriod.endTime}</small>}
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        ) : (
          <p className="editor-empty">Não há pessoas com participação nesta semana.</p>
        )}
      </section>

      {message && <p className="notice success" role="status">{message}</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
    </section>
  );
}

function managementHeaders(token: string, headers: HeadersInit): Headers {
  const result = new Headers(headers);
  result.set("Authorization", `Bearer ${token}`);
  return result;
}

function scheduleURL(spaceID: string, scheduleID: string): string {
  return `${apiBaseUrl}/api/management-spaces/${encodeURIComponent(spaceID)}/schedules/${encodeURIComponent(scheduleID)}`;
}

function dateInTimeZone(timeZone: string, value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function mondayInTimeZone(timeZone: string, value: Date): string {
  return mondayForDate(dateInTimeZone(timeZone, value));
}

function mondayForDate(value: string): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00Z`);
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
}

function dayLabel(state: string): string {
  switch (state) {
    case "outside_participation": return "Fora da participação";
    case "day_off": return "Folga";
    case "work_period": return "Jornada";
    case "vacation": return "Férias";
    case "absence": return "Ausência";
    case "medical_leave": return "Atestado";
    default: return "Não definido";
  }
}

function weekStatus(week: ScheduleWeek | null): string {
  if (!week) return "Carregando a programação semanal";
  if (week.isCurrentWeek) return `Semana atual · ${week.timeZone}`;
  if (week.isPastWeek) return `Semana passada · ${week.timeZone}`;
  return `Semana futura · ${week.timeZone}`;
}
