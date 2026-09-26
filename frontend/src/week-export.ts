import type { ReadLinkDay, ScheduleDay, WorkPeriod } from "./schedule-types";

export type ExportDayState = ScheduleDay["state"] | ReadLinkDay["state"];

export interface WeekExportDay {
  date: string;
  weekday: number;
  state: ExportDayState;
  workPeriod?: WorkPeriod;
  hasException?: boolean;
}

export interface WeekExportPerson {
  person: { name: string };
  days: WeekExportDay[];
}

export interface WeekExportData {
  weekStart: string;
  weekEnd: string;
  people: WeekExportPerson[];
}

export interface WeekExportDocument {
  scheduleName: string;
  week: WeekExportData;
}

export type ExportFormat = "pdf" | "png";
export interface ExportProgress {
  completed: number;
  total: number;
  unit: "pessoas" | "páginas";
}

const canvasWidth = 1120;
const pageWidth = 1120;
const pageHeight = 877;
const nameColumnWidth = 174;
const dayColumnWidth = (canvasWidth - nameColumnWidth) / 7;
const tableTop = 160;
const tableHeaderHeight = 64;
const peopleTop = tableTop + tableHeaderHeight;
const pagePeopleHeight = pageHeight - peopleTop - 54;
const rowPadding = 10;

const statePresentations: Record<ExportDayState, { label: string; background: string; redacted: boolean }> = {
  outside_participation: { label: "Fora da participação", background: "#f7f8f6", redacted: false },
  undefined: { label: "Não definido", background: "#fdfaf0", redacted: false },
  day_off: { label: "Folga", background: "#f0f8f1", redacted: false },
  work_period: { label: "Jornada", background: "#f7fbf7", redacted: false },
  vacation: { label: "Férias", background: "#fff", redacted: false },
  absence: { label: "Ausência", background: "#fff", redacted: false },
  medical_leave: { label: "Indisponível", background: "#f4f5f3", redacted: true },
  unavailable: { label: "Indisponível", background: "#f4f5f3", redacted: true },
};

interface MeasuredPerson {
  person: WeekExportPerson;
  nameLines: string[];
  rowHeight: number;
}

export function weekHasUndefinedDays(week: WeekExportData): boolean {
  return week.people.some((person) => person.days.some((day) => day.state === "undefined"));
}

export async function renderWeekPNG(
  document: WeekExportDocument,
  onProgress: (progress: ExportProgress) => void,
): Promise<Blob> {
  const { week } = document;
  const people = measureExportPeople(week.people);
  const imageHeight = Math.max(peopleTop + 62, peopleTop + people.reduce((height, person) => height + person.rowHeight, 0) + 46);
  const canvas = createCanvas(canvasWidth, imageHeight);
  const context = requireContext(canvas);
  drawHeading(context, document);
  drawTableHeader(context, week);
  let currentY = peopleTop;
  onProgress({ completed: 0, total: people.length, unit: "pessoas" });
  for (let index = 0; index < people.length; index++) {
    drawPersonRow(context, people[index], currentY);
    currentY += people[index].rowHeight;
    if ((index + 1) % 10 === 0 || index + 1 === people.length) {
      onProgress({ completed: index + 1, total: people.length, unit: "pessoas" });
      await nextFrame();
    }
  }
  drawEmptyWeekIfNeeded(context, people);
  return canvasBlob(canvas, "image/png");
}

export async function renderWeekPDF(
  document: WeekExportDocument,
  onProgress: (progress: ExportProgress) => void,
): Promise<Blob> {
  const { week } = document;
  const people = measureExportPeople(week.people);
  const pages = paginatePeople(people);
  const renderedPages: Uint8Array[] = [];
  onProgress({ completed: 0, total: pages.length, unit: "páginas" });
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
    const canvas = createCanvas(pageWidth, pageHeight);
    const context = requireContext(canvas);
    drawHeading(context, document, { current: pageIndex + 1, total: pages.length });
    drawTableHeader(context, week);
    const pagePeople = pages[pageIndex];
    let currentY = peopleTop;
    for (const person of pagePeople) {
      drawPersonRow(context, person, currentY);
      currentY += person.rowHeight;
    }
    drawEmptyWeekIfNeeded(context, people);
    const jpeg = await canvasBlob(canvas, "image/jpeg", 0.92);
    renderedPages.push(new Uint8Array(await jpeg.arrayBuffer()));
    onProgress({ completed: pageIndex + 1, total: pages.length, unit: "páginas" });
    await nextFrame();
  }
  return assemblePDF(renderedPages);
}

export function downloadWeekFile(blob: Blob, fileName: string): void {
  const address = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = address;
  link.download = fileName;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(address), 60_000);
}

function measurePeople(context: CanvasRenderingContext2D, source: WeekExportPerson[]): MeasuredPerson[] {
  setCanvasFont(context, 14, 600);
  return source.map((person) => {
    const nameLines = wrapText(context, person.person.name, nameColumnWidth - rowPadding * 2);
    const nameHeight = nameLines.length * 17 + rowPadding * 2;
    const largestDayHeight = person.days.reduce((largest, day) => {
      const labelLines = wrapText(context, presentationFor(day.state).label, dayColumnWidth - rowPadding * 2);
      const timeLines = day.state === "work_period" && day.workPeriod
        ? 1 + (day.workPeriod.breakStartTime && day.workPeriod.breakEndTime ? 1 : 0)
        : 0;
      const exceptionLines = day.hasException && !presentationFor(day.state).redacted ? 1 : 0;
      return Math.max(largest, labelLines.length * 15 + timeLines * 13 + exceptionLines * 12 + rowPadding * 2);
    }, 0);
    return { person, nameLines, rowHeight: Math.max(66, nameHeight, largestDayHeight) };
  });
}

function measureExportPeople(source: WeekExportPerson[]): MeasuredPerson[] {
  const measurementCanvas = document.createElement("canvas");
  const measurementContext = measurementCanvas.getContext("2d");
  if (!measurementContext) throw new Error("canvas_unavailable");
  setCanvasFont(measurementContext, 14, 600);
  return measurePeople(measurementContext, source);
}

function paginatePeople(people: MeasuredPerson[]): MeasuredPerson[][] {
  if (people.length === 0) return [[]];
  const pages: MeasuredPerson[][] = [];
  let page: MeasuredPerson[] = [];
  let pageHeight = 0;
  for (const person of people) {
    if (page.length > 0 && pageHeight + person.rowHeight > pagePeopleHeight) {
      pages.push(page);
      page = [];
      pageHeight = 0;
    }
    page.push(person);
    pageHeight += person.rowHeight;
  }
  if (page.length > 0) pages.push(page);
  return pages;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function requireContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas_unavailable");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return context;
}

function drawHeading(
  context: CanvasRenderingContext2D,
  document: WeekExportDocument,
  page?: { current: number; total: number },
): void {
  const { week } = document;
  context.fillStyle = "#28694d";
  setCanvasFont(context, 14, 700);
  context.fillText("TurnoCerto", 34, 35);
  context.fillStyle = "#183c2b";
  setCanvasFont(context, 27, 700);
  context.fillText("Programação da semana", 34, 77);
  context.fillStyle = "#354b3e";
  setCanvasFont(context, 17, 600);
  context.fillText(clippedText(context, document.scheduleName, 800), 34, 108);
  context.fillStyle = "#68776d";
  setCanvasFont(context, 13, 500);
  context.fillText(`De ${formatDate(week.weekStart)} a ${formatDate(week.weekEnd)}`, 34, 133);
  if (page) {
    context.textAlign = "right";
    context.fillText(`Página ${page.current} de ${page.total}`, canvasWidth - 34, 35);
    context.textAlign = "left";
  }
}

function drawTableHeader(context: CanvasRenderingContext2D, week: WeekExportData): void {
  context.fillStyle = "#eaf2eb";
  context.fillRect(0, tableTop, canvasWidth, tableHeaderHeight);
  context.strokeStyle = "#d7e3d8";
  context.lineWidth = 1;
  context.strokeRect(0.5, tableTop + 0.5, canvasWidth - 1, tableHeaderHeight - 1);
  context.fillStyle = "#324a3a";
  setCanvasFont(context, 12, 700);
  context.fillText("Pessoa", 14, tableTop + 37);
  const firstDay = new Date(`${week.weekStart}T12:00:00Z`);
  for (let index = 0; index < 7; index++) {
    const date = new Date(firstDay);
    date.setUTCDate(date.getUTCDate() + index);
    const x = nameColumnWidth + index * dayColumnWidth;
    context.strokeStyle = "#d7e3d8";
    context.beginPath();
    context.moveTo(x, tableTop);
    context.lineTo(x, tableTop + tableHeaderHeight);
    context.stroke();
    setCanvasFont(context, 12, 700);
    context.fillStyle = "#324a3a";
    context.fillText(weekdayName(index), x + 9, tableTop + 26);
    setCanvasFont(context, 11, 500);
    context.fillStyle = "#64766a";
    context.fillText(formatDate(date.toISOString().slice(0, 10)), x + 9, tableTop + 46);
  }
  context.beginPath();
  context.moveTo(nameColumnWidth, tableTop);
  context.lineTo(nameColumnWidth, tableTop + tableHeaderHeight);
  context.stroke();
}

function drawPersonRow(context: CanvasRenderingContext2D, person: MeasuredPerson, y: number): void {
  context.fillStyle = "#f7faf7";
  context.fillRect(0, y, nameColumnWidth, person.rowHeight);
  context.strokeStyle = "#dce6dd";
  context.lineWidth = 1;
  context.strokeRect(0.5, y + 0.5, nameColumnWidth - 1, person.rowHeight - 1);
  context.fillStyle = "#2f4436";
  setCanvasFont(context, 14, 600);
  drawLines(context, person.nameLines, 12, verticallyCenteredTop(y, person.rowHeight, person.nameLines.length, 17), 17);

  const days = person.person.days;
  for (let index = 0; index < 7; index++) {
    const day = days[index];
    const x = nameColumnWidth + index * dayColumnWidth;
    context.fillStyle = presentationFor(day?.state ?? "undefined").background;
    context.fillRect(x, y, dayColumnWidth, person.rowHeight);
    context.strokeStyle = "#dce6dd";
    context.strokeRect(x + 0.5, y + 0.5, dayColumnWidth - 1, person.rowHeight - 1);
    const presentation = presentationFor(day?.state ?? "undefined");
    const labelLines = wrapText(context, presentation.label, dayColumnWidth - rowPadding * 2);
    const lines = [...labelLines];
    if (day?.state === "work_period" && day.workPeriod) {
      lines.push(`${day.workPeriod.startTime}–${day.workPeriod.endTime}`);
      if (day.workPeriod.breakStartTime && day.workPeriod.breakEndTime) {
        lines.push(`Intervalo ${day.workPeriod.breakStartTime}–${day.workPeriod.breakEndTime}`);
      }
    }
    if (day?.hasException && !presentation.redacted) lines.push("Exceção");
    setCanvasFont(context, 11, 600);
    context.fillStyle = "#344a3b";
    const lineHeight = 14;
    const top = verticallyCenteredTop(y, person.rowHeight, lines.length, lineHeight);
    drawLines(context, lines, x + rowPadding, top, lineHeight);
  }
}

function drawEmptyWeek(context: CanvasRenderingContext2D, y: number): void {
  context.fillStyle = "#64766a";
  setCanvasFont(context, 14, 500);
  context.fillText("Não há pessoas com participação nesta semana.", 16, y);
}

function drawEmptyWeekIfNeeded(context: CanvasRenderingContext2D, people: MeasuredPerson[]): void {
  if (people.length === 0) drawEmptyWeek(context, peopleTop + 34);
}

function drawLines(context: CanvasRenderingContext2D, lines: string[], x: number, y: number, lineHeight: number): void {
  for (let index = 0; index < lines.length; index++) context.fillText(lines[index], x, y + index * lineHeight);
}

function verticallyCenteredTop(y: number, rowHeight: number, lineCount: number, lineHeight: number): number {
  return y + Math.max(rowPadding + lineHeight - 2, (rowHeight - Math.max(1, lineCount) * lineHeight) / 2 + lineHeight - 2);
}

function wrapText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (context.measureText(word).width > maxWidth) {
      if (line) lines.push(line);
      line = "";
      let segment = "";
      for (const character of word) {
        const candidate = segment + character;
        if (segment && context.measureText(candidate).width > maxWidth) {
          lines.push(segment);
          segment = character;
        } else segment = candidate;
      }
      line = segment;
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (line && context.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function clippedText(context: CanvasRenderingContext2D, value: string, maxWidth: number): string {
  if (context.measureText(value).width <= maxWidth) return value;
  let result = value;
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}

function presentationFor(state: ExportDayState): { label: string; background: string; redacted: boolean } {
  return statePresentations[state] ?? statePresentations.unavailable;
}

function setCanvasFont(context: CanvasRenderingContext2D, size: number, weight: number): void {
  context.font = `${weight} ${size}px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
}

function weekdayName(index: number): string {
  return ["Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado", "Domingo"][index];
}

function formatDate(value: string): string {
  const date = typeof value === "string" ? new Date(`${value.slice(0, 10)}T12:00:00Z`) : new Date(value);
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(date);
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("export_blob_unavailable"));
      }, type, quality);
    } catch (error) {
      reject(error);
    }
  });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function assemblePDF(images: Uint8Array[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets = new Array<number>(3 + images.length * 3).fill(0);
  let length = 0;
  const append = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.byteLength;
  };
  const object = (id: number, body: string | Uint8Array) => {
    offsets[id] = length;
    append(`${id} 0 obj\n`);
    append(body);
    append("\nendobj\n");
  };

  append("%PDF-1.4\n");
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  const pageIDs = images.map((_, index) => 3 + index * 3);
  object(2, `<< /Type /Pages /Count ${images.length} /Kids [${pageIDs.map((id) => `${id} 0 R`).join(" ")}] >>`);
  for (let index = 0; index < images.length; index++) {
    const pageID = pageIDs[index];
    const imageID = pageID + 1;
    const contentID = pageID + 2;
    object(pageID, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.89 595.28] /Resources << /XObject << /Im0 ${imageID} 0 R >> >> /Contents ${contentID} 0 R >>`);
    append(`${imageID} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pageWidth} /Height ${pageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${images[index].byteLength} >>\nstream\n`);
    offsets[imageID] = length - encoder.encode(`${imageID} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pageWidth} /Height ${pageHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${images[index].byteLength} >>\nstream\n`).byteLength;
    append(images[index]);
    append("\nendstream\nendobj\n");
    const content = `q\n841.89 0 0 595.28 0 0 cm\n/Im0 Do\nQ`;
    const contentBytes = encoder.encode(content);
    object(contentID, `<< /Length ${contentBytes.byteLength} >>\nstream\n${content}\nendstream`);
  }
  const xrefOffset = length;
  append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (let id = 1; id < offsets.length; id++) append(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  append(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Blob([bytes.buffer], { type: "application/pdf" });
}
