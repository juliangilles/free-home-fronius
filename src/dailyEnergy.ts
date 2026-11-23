import fs from "fs";
import path from "path";

/**
 * Berechnet Tageswerte aus Zählerständen, weil z.B. der GEN24 keinen Tagesertrag liefert.
 * Der Zählerstand zu Tagesbeginn wird in einer Datei gespeichert, damit die Tageswerte
 * einen Neustart des Add-Ons überleben.
 */
export class DailyEnergy {
  private state: { day: string; baselines: Record<string, number> };

  constructor(private file = path.join(process.cwd(), "daily-energy.json")) {
    this.state = { day: today(), baselines: {} };
    try {
      const loaded = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (loaded?.day === this.state.day && loaded.baselines) this.state = loaded;
    } catch {
      // keine gespeicherten Werte
    }
  }

  /** Liefert den Zuwachs seit Tagesbeginn (gleiche Einheit wie total). */
  delta(key: string, total: number | null): number | null {
    if (total === null) return null;
    const day = today();
    if (day !== this.state.day) {
      this.state = { day, baselines: {} };
    }
    let base = this.state.baselines[key];
    if (base === undefined || total < base) {
      base = this.state.baselines[key] = total;
      this.save();
    }
    return total - base;
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.state));
    } catch {
      // Dateisystem evtl. schreibgeschützt – dann nur im Speicher
    }
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
