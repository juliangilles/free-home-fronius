import http from "http";

/** Werte, die das Add-On aus der Fronius Solar API v1 zusammenstellt. */
export interface FroniusSnapshot {
  /** AC-Ausgangsleistung Wechselrichter in W (>= 0) */
  pvPower: number;
  /** Netzleistung in W: > 0 Bezug, < 0 Einspeisung */
  gridPower: number;
  /** Hausverbrauch in W (>= 0) */
  loadPower: number;
  /** Batterieleistung in W (> 0 Entladung, < 0 Ladung), null wenn keine Batterie */
  batteryPower: number | null;
  /** Autarkiegrad in % */
  autonomy: number | null;
  /** Eigenverbrauchsquote in % */
  selfConsumption: number | null;
  /** Gesamtertrag Wechselrichter in Wh */
  pvEnergyTotal: number | null;
  /** Tagesertrag in Wh, falls der Wechselrichter ihn liefert (GEN24 liefert null) */
  pvEnergyDay: number | null;
  /** Zählerstand Netzbezug in Wh (Smart Meter) */
  gridImportTotal: number | null;
  /** Zählerstand Einspeisung in Wh (Smart Meter) */
  gridExportTotal: number | null;
  /** Status des Wechselrichters, z.B. "Running" */
  inverterState: string | null;
}

interface SolarApiResponse<T> {
  Body: { Data: T };
  Head: { Status: { Code: number; Reason: string } };
}

export class FroniusClient {
  constructor(
    private host: string,
    private port: number,
    private timeoutMs = 5000
  ) {}

  private get<T>(path: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: this.host, port: this.port, path, timeout: this.timeoutMs },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`HTTP ${res.statusCode} für ${path}`));
            return;
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              const json = JSON.parse(body) as SolarApiResponse<T>;
              if (json.Head?.Status?.Code !== 0) {
                reject(new Error(`Solar API Fehler ${json.Head?.Status?.Code}: ${json.Head?.Status?.Reason}`));
                return;
              }
              resolve(json.Body.Data);
            } catch (e) {
              reject(e);
            }
          });
        }
      );
      req.on("timeout", () => req.destroy(new Error(`Timeout bei ${path}`)));
      req.on("error", reject);
    });
  }

  async read(): Promise<FroniusSnapshot> {
    const flow = await this.get<any>("/solar_api/v1/GetPowerFlowRealtimeData.fcgi");
    const site = flow.Site ?? {};
    const inverters: any[] = Object.values(flow.Inverters ?? {});

    const sum = (key: string): number | null => {
      const values = inverters.map((i) => i[key]).filter((v) => typeof v === "number");
      return values.length ? values.reduce((a: number, b: number) => a + b, 0) : null;
    };

    // Smart Meter (Zählerstände) – optional
    let gridImportTotal: number | null = null;
    let gridExportTotal: number | null = null;
    try {
      const meters = await this.get<Record<string, any>>("/solar_api/v1/GetMeterRealtimeData.cgi?Scope=System");
      const all = Object.values(meters);
      // Meter_Location_Current 0 = Einspeisepunkt (Netz)
      const grid = all.find((m) => m.Meter_Location_Current === 0) ?? all[0];
      if (grid) {
        gridImportTotal = num(grid.EnergyReal_WAC_Sum_Consumed ?? grid.EnergyReal_WAC_Plus_Absolute);
        gridExportTotal = num(grid.EnergyReal_WAC_Sum_Produced ?? grid.EnergyReal_WAC_Minus_Absolute);
      }
    } catch {
      // kein Smart Meter vorhanden
    }

    // Wechselrichterstatus – optional
    let inverterState: string | null = null;
    try {
      const inv = await this.get<any>(
        "/solar_api/v1/GetInverterRealtimeData.cgi?Scope=Device&DeviceId=1&DataCollection=CommonInverterData"
      );
      inverterState = inv.DeviceStatus?.InverterState ?? null;
    } catch {
      // ignorieren
    }

    return {
      pvPower: Math.max(0, sum("P") ?? num(site.P_PV) ?? 0),
      gridPower: num(site.P_Grid) ?? 0,
      // Fronius liefert P_Load negativ für Verbrauch
      loadPower: Math.abs(num(site.P_Load) ?? 0),
      batteryPower: num(site.P_Akku),
      autonomy: num(site.rel_Autonomy),
      selfConsumption: num(site.rel_SelfConsumption),
      pvEnergyTotal: sum("E_Total") ?? num(site.E_Total),
      pvEnergyDay: sum("E_Day") ?? num(site.E_Day),
      gridImportTotal,
      gridExportTotal,
      inverterState,
    };
  }
}

function num(v: unknown): number | null {
  return typeof v === "number" && isFinite(v) ? v : null;
}
