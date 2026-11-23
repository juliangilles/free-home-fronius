import {
  AddOn,
  Capabilities,
  EnergyInverterV2Channel,
  EnergyOneWayMeterV2Channel,
  EnergyTwoWayMeterV2Channel,
  FreeAtHome,
} from "@busch-jaeger/free-at-home";
import { DailyEnergy } from "./dailyEnergy";
import { FroniusClient, FroniusSnapshot } from "./fronius";

interface Settings {
  host: string;
  port: number;
  pollInterval: number;
}

const DEFAULTS: Settings = { host: "192.168.150.10", port: 8080, pollInterval: 10 };

const freeAtHome = new FreeAtHome();
freeAtHome.activateSignalHandling();

const metaData = AddOn.readMetaData();
const addOn = new AddOn.AddOn(metaData.id);

let settings: Settings = { ...DEFAULTS };
let client = new FroniusClient(settings.host, settings.port);
let timer: NodeJS.Timeout | undefined;
let online = false;

let inverter: EnergyInverterV2Channel;
let gridMeter: EnergyTwoWayMeterV2Channel;
let houseMeter: EnergyOneWayMeterV2Channel;
const devices = () => [inverter, gridMeter, houseMeter];
const daily = new DailyEnergy();

async function main() {
  inverter = await freeAtHome.createEnergyInverterV2Device("fronius-inverter", "Fronius Wechselrichter", [
    Capabilities.CAP_ENERGY_CURRENT_POWER,
    Capabilities.CAP_ENERGY_TODAY,
    Capabilities.CAP_ENERGY_TOTAL,
  ]);
  gridMeter = await freeAtHome.createEnergyTwoWayMeterV2Device("fronius-grid-meter", "Fronius Smart Meter", [
    Capabilities.CAP_ENERGY_CURRENT_POWER,
    Capabilities.CAP_ENERGY_CURRENT_EXCESS_POWER,
    Capabilities.CAP_ENERGY_TODAY,
    Capabilities.CAP_ENERGY_TOTAL,
    Capabilities.CAP_ENERGY_IMPORT,
    Capabilities.CAP_ENERGY_EXPORT,
  ]);
  houseMeter = await freeAtHome.createEnergyOneWayMeterV2Device("fronius-house", "Fronius Hausverbrauch", [
    Capabilities.CAP_ENERGY_CURRENT_POWER,
    Capabilities.CAP_ENERGY_TODAY,
    Capabilities.CAP_ENERGY_TOTAL,
    Capabilities.CAP_ENERGY_EXPORT,
  ]);

  addOn.on("configurationChanged", (configuration: any) => {
    const items = configuration?.default?.items ?? {};
    settings = {
      host: String(items.host || DEFAULTS.host),
      port: Number(items.port) || DEFAULTS.port,
      pollInterval: Math.max(2, Number(items.pollInterval) || DEFAULTS.pollInterval),
    };
    console.log("Konfiguration:", settings);
    client = new FroniusClient(settings.host, settings.port);
    restartPolling();
  });
  addOn.connectToConfiguration();

  restartPolling();
}

function restartPolling() {
  if (timer) clearInterval(timer);
  poll();
  timer = setInterval(poll, settings.pollInterval * 1000);
}

let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const data = await client.read();
    await publish(data);
    if (!online) {
      console.log(`Verbunden mit Fronius ${settings.host}:${settings.port}`);
      console.log(
        `PV ${data.pvPower.toFixed(0)} W, Netz ${data.gridPower.toFixed(0)} W, Haus ${data.loadPower.toFixed(0)} W, ` +
          `Zähler Bezug ${data.gridImportTotal ?? "-"} Wh / Einspeisung ${data.gridExportTotal ?? "-"} Wh`
      );
      devices().forEach((dev) => dev.setAutoKeepAlive(true));
      online = true;
    }
  } catch (e) {
    console.error("Fronius-Abfrage fehlgeschlagen:", errorText(e));
    if (online) {
      online = false;
      for (const dev of devices()) {
        dev.setAutoKeepAlive(false);
        await dev.setUnresponsive().catch(() => undefined);
      }
    }
  } finally {
    polling = false;
  }
}

const fmt = (v: number, digits = 0) => v.toFixed(digits);

/** Lesbarer Fehlertext, auch wenn der Fehler kein Error-Objekt ist. */
function errorText(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/** Datapoints, deren Fehler schon protokolliert wurde (verhindert Log-Flut). */
const failing = new Set<string>();

/**
 * Setzt einen Datapoint unabhängig von den anderen. Ein Fehler bei einem Wert
 * darf die übrigen Werte nicht blockieren.
 */
async function set(name: string, value: number | null, digits: number, setter: (v: string) => Promise<void>) {
  if (value === null || !isFinite(value)) return;
  const text = fmt(value, digits);
  try {
    await setter(text);
    if (failing.delete(name)) console.log(`${name}: wird wieder gesetzt (${text})`);
  } catch (e) {
    if (!failing.has(name)) {
      failing.add(name);
      console.error(`${name}: konnte nicht gesetzt werden (Wert ${text}):`, errorText(e));
    }
  }
}

/** Zuletzt gesendete Tageswerte, für das Diagnose-Protokoll. */
let lastSent: { pvToday: number | null; importToday: number | null; exportToday: number | null; houseToday: number | null; pvTotal: number | null } | undefined;
const DAILY_LOG_INTERVAL_MS = 15 * 60 * 1000;
let lastDailyLog = 0;

/** Schreibt die gesendeten Tageswerte beim Start und danach alle 15 Minuten ins Protokoll. */
function logDailyIfDue() {
  const now = Date.now();
  if (!lastSent || now - lastDailyLog < DAILY_LOG_INTERVAL_MS) return;
  lastDailyLog = now;
  const wh = (v: number | null) => (v === null ? "-" : `${v.toFixed(0)} Wh`);
  console.log(
    `Tageswerte gesendet: PV heute ${wh(lastSent.pvToday)}, Bezug heute ${wh(lastSent.importToday)}, ` +
      `Einspeisung heute ${wh(lastSent.exportToday)}, Haus heute ${wh(lastSent.houseToday)} (PV-Zähler ${lastSent.pvTotal?.toFixed(0) ?? "-"} Wh)`
  );
}

let houseTotalMax: number | null = null;

/** PV + Bezug − Einspeisung, nie negativ; null wenn ein Wert fehlt. */
function sumOrNull(pv: number | null, imp: number | null, exp: number | null): number | null {
  if (pv === null || imp === null || exp === null) return null;
  return Math.max(0, pv + imp - exp);
}

async function publish(d: FroniusSnapshot) {
  const pvToday = d.pvEnergyDay ?? daily.delta("pv", d.pvEnergyTotal);
  const importToday = daily.delta("gridImport", d.gridImportTotal);
  const exportToday = daily.delta("gridExport", d.gridExportTotal);
  const kWh = (wh: number | null) => (wh === null ? null : wh / 1000);

  // Hausverbrauch-Energie: Fronius hat keinen eigenen Zähler, daher
  // Verbrauch = PV-Ertrag + Netzbezug − Einspeisung (Anlage ohne Batterie).
  const houseToday = sumOrNull(pvToday, importToday, exportToday);
  const houseTotalRaw = sumOrNull(d.pvEnergyTotal, d.gridImportTotal, d.gridExportTotal);
  // Die Zähler aktualisieren unterschiedlich schnell (PV nur alle paar Minuten),
  // daher den Gesamtwert nie kleiner werden lassen.
  if (houseTotalRaw !== null) houseTotalMax = Math.max(houseTotalMax ?? 0, houseTotalRaw);

  lastSent = { pvToday, importToday, exportToday, houseToday, pvTotal: d.pvEnergyTotal };
  logDailyIfDue();

  await Promise.all([
    // --- Netz / Smart Meter ---
    // > 0 Bezug, < 0 Einspeisung (gleiche Konvention wie Fronius P_Grid)
    set("Netz Leistung", d.gridPower, 0, (v) => gridMeter.setCurrentPowerConsumed(v)),
    set("Netz Überschuss", Math.max(0, -d.gridPower), 0, (v) => gridMeter.setCurrentExcessPower(v)),
    set("Netz Bezug heute", importToday, 0, (v) => gridMeter.setImportedEnergyToday(v)),
    set("Netz Einspeisung heute", exportToday, 0, (v) => gridMeter.setExportedEnergyToday(v)),
    set("Netz Bezug gesamt", kWh(d.gridImportTotal), 0, (v) => gridMeter.setTotalEnergyImported(v)),
    set("Netz Einspeisung gesamt", kWh(d.gridExportTotal), 0, (v) => gridMeter.setTotalEnergyExported(v)),

    // --- Wechselrichter ---
    // Erzeugung positiv senden. Die SDK-Doku nennt <= 0, der SysAP zeigt dann aber
    // "Produktion -590 W" an und rechnet den Haushalt falsch (Haushalt = Netz + PV).
    set("PV Leistung", d.pvPower, 0, (v) => inverter.setCurrentPowerConsumed(v)),
    set("PV Ertrag heute", pvToday, 0, (v) => inverter.setImportedEnergyToday(v)),
    set("PV Ertrag gesamt", kWh(d.pvEnergyTotal), 0, (v) => inverter.setTotalEnergyImported(v)),
    set("Eigenverbrauch", d.selfConsumption, 0, (v) => inverter.setSelfConsumption(v)),
    set("Autarkie", d.autonomy, 0, (v) => inverter.setSelfSufficiency(v)),

    // --- Hausverbrauch (Verbrauchszähler) ---
    set("Haus Leistung", d.loadPower, 0, (v) => houseMeter.setCurrentPowerConsumed(v)),
    set("Haus Verbrauch heute", houseToday, 0, (v) => houseMeter.setExportedEnergyToday(v)),
    set("Haus Verbrauch gesamt", kWh(houseTotalMax), 0, (v) => houseMeter.setTotalEnergyExported(v)),
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
