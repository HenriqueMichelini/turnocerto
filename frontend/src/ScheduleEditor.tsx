import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { WeekExportControls } from "./WeekExportControls";
import type { DateException, PatternDay, Person, Schedule, ScheduleEditRequest, ScheduleDay, ScheduleWeek, WorkPeriod } from "./schedule-types";

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

interface DayEditState {
  state: DateException["state"];
  startTime: string;
  endTime: string;
  breakStartTime: string;
  breakEndTime: string;
  removeException: boolean;
}

type EditMode = ScheduleEditRequest["mode"];

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
  const [selectedDays, setSelectedDays] = useState<Record<string, string[]>>({});
  const [editModes, setEditModes] = useState<Record<string, EditMode>>({});
  const [dayDrafts, setDayDrafts] = useState<Record<string, Record<string, DayEditState>>>({});
  const [removeFutureExceptions, setRemoveFutureExceptions] = useState<Record<string, boolean>>({});
  const [isSavingEdit, setIsSavingEdit] = useState<string | null>(null);
  const [conflictedParticipation, setConflictedParticipation] = useState<string | null>(null);
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
    setSelectedDays({});
    setEditModes({});
    setDayDrafts({});
    setRemoveFutureExceptions({});
    setConflictedParticipation(null);
    setWeek(null);
  }, [selectedSchedule.id, selectedSchedule.timeZone]);

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
        if (active) {
          setWeek(result.week);
          setSelectedDays({});
          setEditModes({});
          setDayDrafts({});
          setRemoveFutureExceptions({});
          setConflictedParticipation(null);
        }
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
      await response.json() as { participation: unknown };
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

  async function saveScheduleEdit(event: FormEvent<HTMLFormElement>, personWeek: ScheduleWeek["people"][number]) {
    event.preventDefault();
    const participationID = personWeek.participationId;
    const mode = editModes[participationID] ?? "once";
    const days = personWeek.days.filter((day) => (selectedDays[participationID] ?? []).includes(day.date));
    if (days.length === 0) {
      setError("Selecione ao menos uma data para editar.");
      return;
    }
    const drafts = dayDrafts[participationID] ?? {};
    const updates = days.map((day) => ({ day, draft: drafts[day.date] ?? dayEditFromScheduleDay(day, mode) }));
    if (updates.some(({ day, draft }) => !(mode === "once" && day.hasException && draft.removeException) && !validDayDraft(draft, mode))) {
      setError(mode === "recurring"
        ? "Confira as jornadas e escolha um dia recorrente. Férias, ausência e atestado só podem ser lançados em datas específicas."
        : "Confira os horários das jornadas e dos intervalos antes de salvar.");
      return;
    }
    const removeDates = mode === "once"
      ? updates.filter(({ day, draft }) => day.hasException && draft.removeException).map(({ day }) => day.date)
      : [];
    const edit: ScheduleEditRequest = {
      revision: week?.revision ?? "",
      weekStart: week?.weekStart ?? weekStart,
      mode,
      ...(mode === "once"
        ? {
            dates: updates.filter(({ day, draft }) => !(day.hasException && draft.removeException)).map(({ day, draft }) => dateExceptionFromDraft(day.date, draft)),
            ...(removeDates.length > 0 ? { removeDates } : {}),
          }
        : {
            weekdays: updates.map(({ day, draft }) => patternDayFromDraft(day.weekday, draft)),
            removeFutureExceptions: removeFutureExceptions[participationID] ?? false,
          }),
    };
    setIsSavingEdit(participationID);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`${apiBaseUrl}/api/management-spaces/${encodeURIComponent(spaceID)}/schedules/${encodeURIComponent(selectedSchedule.id)}/participations/${encodeURIComponent(participationID)}/edits`, {
        method: "POST",
        headers: managementHeaders(managementToken, { Accept: "application/json", "Content-Type": "application/json" }),
        body: JSON.stringify(edit),
      });
      if (response.status === 409) {
        setConflictedParticipation(participationID);
        setError("Outra pessoa salvou uma alteração enquanto esta semana estava aberta. Reabra a semana para carregar a versão mais recente antes de tentar novamente.");
        return;
      }
      if (!response.ok) {
        setError("Não foi possível salvar a alteração. Confira as datas e os horários selecionados.");
        return;
      }
      setMessage(mode === "once"
        ? removeDates.length > 0 && updates.length === removeDates.length
          ? "Exceção removida; o padrão recorrente voltou a valer nesta data."
          : "Alteração salva somente para as datas selecionadas."
        : `Padrão recorrente salvo a partir de ${formatDate(week?.weekStart ?? weekStart)}.`);
      setReloadVersion((version) => version + 1);
    } catch {
      setError("Não foi possível salvar agora. Confira sua conexão e tente novamente.");
    } finally {
      setIsSavingEdit(null);
    }
  }

  function toggleEditDay(participationID: string, day: ScheduleDay, checked: boolean) {
    setSelectedDays((current) => {
      const next = new Set(current[participationID] ?? []);
      if (checked) next.add(day.date);
      else next.delete(day.date);
      return { ...current, [participationID]: [...next] };
    });
    if (checked) {
      setDayDrafts((current) => {
        if (current[participationID]?.[day.date]) return current;
        return {
          ...current,
          [participationID]: {
            ...current[participationID],
            [day.date]: dayEditFromScheduleDay(day, editModes[participationID] ?? "once"),
          },
        };
      });
    }
  }

  function changeEditMode(personWeek: ScheduleWeek["people"][number], mode: EditMode) {
    const participationID = personWeek.participationId;
    setEditModes((current) => ({ ...current, [participationID]: mode }));
    if (mode === "recurring") {
      const selected = new Set(selectedDays[participationID] ?? []);
      setDayDrafts((current) => ({
        ...current,
        [participationID]: {
          ...current[participationID],
          ...Object.fromEntries(personWeek.days.filter((day) => selected.has(day.date)).map((day) => [day.date, dayEditFromScheduleDay(day, mode)])),
        },
      }));
    }
  }

  function updateDayDraft(participationID: string, date: string, update: Partial<DayEditState>) {
    setDayDrafts((current) => ({
      ...current,
      [participationID]: {
        ...current[participationID],
        [date]: { ...current[participationID]?.[date], ...update },
      },
    }));
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
          {week && !isLoadingWeek && week.weekStart === weekStart && (
            <WeekExportControls scheduleName={selectedSchedule.name} week={week} />
          )}
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
                    <label className={`week-day week-day-${day.state}${(selectedDays[personWeek.participationId] ?? []).includes(day.date) ? " week-day-selected" : ""}`} key={day.date}>
                      <input
                        type="checkbox"
                        aria-label={`Selecionar ${weekdayNames[day.weekday - 1]} ${formatDate(day.date)} para edição`}
                        checked={(selectedDays[personWeek.participationId] ?? []).includes(day.date)}
                        disabled={day.state === "outside_participation"}
                        onChange={(event) => toggleEditDay(personWeek.participationId, day, event.target.checked)}
                      />
                      <span>{dayLabel(day.state)}</span>
                      {day.workPeriod && <small>{day.workPeriod.startTime}–{day.workPeriod.endTime}</small>}
                    </label>
                  ))}
                </div>
                <form className="week-edit-form" onSubmit={(event) => void saveScheduleEdit(event, personWeek)}>
                  <fieldset className="pattern-fieldset">
                    <legend>Editar datas de {personWeek.person.name}</legend>
                    <div className="week-edit-modes">
                      <label>
                        <input
                          type="radio"
                          name={`edit-mode-${personWeek.participationId}`}
                          checked={(editModes[personWeek.participationId] ?? "once") === "once"}
                          onChange={() => changeEditMode(personWeek, "once")}
                        />
                        Somente as datas selecionadas
                      </label>
                      <label>
                        <input
                          type="radio"
                          name={`edit-mode-${personWeek.participationId}`}
                          checked={editModes[personWeek.participationId] === "recurring"}
                          disabled={week.isPastWeek}
                          onChange={() => changeEditMode(personWeek, "recurring")}
                        />
                        Padrão recorrente desde segunda-feira, {formatDate(week.weekStart)}
                      </label>
                    </div>
                    {week.isPastWeek && <p className="week-edit-help">Semanas passadas permitem apenas correções pontuais.</p>}
                    {(selectedDays[personWeek.participationId] ?? []).length === 0 ? (
                      <p className="week-edit-help">Selecione uma ou mais datas na programação acima.</p>
                    ) : (
                      <div className="week-edit-day-list">
                        {personWeek.days.filter((day) => (selectedDays[personWeek.participationId] ?? []).includes(day.date)).map((day) => {
                          const draft = dayDrafts[personWeek.participationId]?.[day.date] ?? dayEditFromScheduleDay(day, editModes[personWeek.participationId] ?? "once");
                          const mode = editModes[personWeek.participationId] ?? "once";
                          const id = `${personWeek.participationId}-${day.date}`;
                          return (
                            <div className="week-edit-day" key={day.date}>
                              <strong>{weekdayNames[day.weekday - 1]} · {formatDate(day.date)}</strong>
                              {mode === "once" && day.hasException && (
                                <label className="remove-date-exception">
                                  <input
                                    type="checkbox"
                                    checked={draft.removeException}
                                    onChange={(event) => updateDayDraft(personWeek.participationId, day.date, { removeException: event.target.checked })}
                                  />
                                  Remover a exceção e usar o padrão semanal
                                </label>
                              )}
                              {!(mode === "once" && day.hasException && draft.removeException) && <>
                              <label htmlFor={`edit-state-${id}`}>Programação</label>
                              <select id={`edit-state-${id}`} value={draft.state} onChange={(event) => updateDayDraft(personWeek.participationId, day.date, { state: event.target.value as DateException["state"] })}>
                                <option value="undefined">Não definido</option>
                                <option value="day_off">Folga</option>
                                <option value="work_period">Jornada</option>
                                {mode === "once" && <>
                                  <option value="vacation">Férias</option>
                                  <option value="absence">Ausência</option>
                                  <option value="medical_leave">Atestado</option>
                                </>}
                              </select>
                              {draft.state === "work_period" && (
                                <div className="week-edit-times">
                                  <label htmlFor={`edit-start-${id}`}>Início</label>
                                  <input id={`edit-start-${id}`} type="time" value={draft.startTime} onChange={(event) => updateDayDraft(personWeek.participationId, day.date, { startTime: event.target.value })} required />
                                  <label htmlFor={`edit-end-${id}`}>Fim</label>
                                  <input id={`edit-end-${id}`} type="time" value={draft.endTime} onChange={(event) => updateDayDraft(personWeek.participationId, day.date, { endTime: event.target.value })} required />
                                  <label htmlFor={`edit-break-start-${id}`}>Intervalo, início</label>
                                  <input id={`edit-break-start-${id}`} type="time" value={draft.breakStartTime} onChange={(event) => updateDayDraft(personWeek.participationId, day.date, { breakStartTime: event.target.value })} />
                                  <label htmlFor={`edit-break-end-${id}`}>Intervalo, fim</label>
                                  <input id={`edit-break-end-${id}`} type="time" value={draft.breakEndTime} onChange={(event) => updateDayDraft(personWeek.participationId, day.date, { breakEndTime: event.target.value })} />
                                </div>
                              )}
                              </>}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {(editModes[personWeek.participationId] ?? "once") === "recurring" && (
                      <fieldset className="week-edit-exceptions">
                        <legend>Exceções nas pessoas e dias alterados</legend>
                        <label>
                          <input type="radio" name={`exceptions-${personWeek.participationId}`} checked={!(removeFutureExceptions[personWeek.participationId] ?? false)} onChange={() => setRemoveFutureExceptions((current) => ({ ...current, [personWeek.participationId]: false }))} />
                          Preservar as exceções existentes (padrão)
                        </label>
                        <label>
                          <input type="radio" name={`exceptions-${personWeek.participationId}`} checked={removeFutureExceptions[personWeek.participationId] ?? false} onChange={() => setRemoveFutureExceptions((current) => ({ ...current, [personWeek.participationId]: true }))} />
                          Remover exceções futuras somente nos dias selecionados
                        </label>
                      </fieldset>
                    )}
                    <button className="primary-button" type="submit" disabled={isSavingEdit === personWeek.participationId || (selectedDays[personWeek.participationId] ?? []).length === 0}>
                      {isSavingEdit === personWeek.participationId ? "Salvando…" : (editModes[personWeek.participationId] ?? "once") === "once" ? "Salvar alteração pontual" : "Salvar padrão recorrente"}
                    </button>
                  </fieldset>
                </form>
              </section>
            ))}
          </div>
        ) : (
          <p className="editor-empty">Não há pessoas com participação nesta semana.</p>
        )}
      </section>

      {message && <p className="notice success" role="status">{message}</p>}
      {error && <div className="notice error" role="alert">
        <p>{error}</p>
        {conflictedParticipation && <button type="button" onClick={() => {
          setError("");
          setConflictedParticipation(null);
          setReloadVersion((version) => version + 1);
        }}>Reabrir semana</button>}
      </div>}
    </section>
  );
}

function dayEditFromScheduleDay(day: ScheduleDay, mode: EditMode): DayEditState {
  const pointState = day.state === "outside_participation" ? "undefined" : day.state;
  const recurringState = day.patternState ?? (pointState === "vacation" || pointState === "absence" || pointState === "medical_leave" ? "undefined" : pointState);
  const recurringPeriod = day.patternWorkPeriod ?? day.workPeriod;
  const period = mode === "recurring" ? recurringPeriod : day.workPeriod;
  return {
    state: mode === "recurring" ? recurringState : pointState,
    startTime: period?.startTime ?? "09:00",
    endTime: period?.endTime ?? "17:00",
    breakStartTime: period?.breakStartTime ?? "",
    breakEndTime: period?.breakEndTime ?? "",
    removeException: false,
  };
}

function validDayDraft(draft: DayEditState, mode: EditMode): boolean {
  if (mode === "recurring" && (draft.state === "vacation" || draft.state === "absence" || draft.state === "medical_leave")) return false;
  if (draft.state !== "work_period") return true;
  return draft.startTime !== "" && draft.endTime !== "" && Boolean(draft.breakStartTime) === Boolean(draft.breakEndTime);
}

function dateExceptionFromDraft(date: string, draft: DayEditState): DateException {
  return {
    date,
    state: draft.state,
    ...(draft.state === "work_period" ? { workPeriod: workPeriodFromDraft(draft) } : {}),
  };
}

function patternDayFromDraft(weekday: number, draft: DayEditState): PatternDay {
  return {
    weekday,
    state: draft.state as PatternDay["state"],
    ...(draft.state === "work_period" ? { workPeriod: workPeriodFromDraft(draft) } : {}),
  };
}

function workPeriodFromDraft(draft: DayEditState): WorkPeriod {
  return {
    startTime: draft.startTime,
    endTime: draft.endTime,
    ...(draft.breakStartTime ? { breakStartTime: draft.breakStartTime } : {}),
    ...(draft.breakEndTime ? { breakEndTime: draft.breakEndTime } : {}),
  };
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
