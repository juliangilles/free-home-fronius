/**
 * Testet nur die Fronius-Abfrage, ohne free@home/SysAP.
 * Aufruf: npm run probe -- [host] [port]
 */
import { FroniusClient } from "./fronius";

const host = process.argv[2] ?? "192.168.150.10";
const port = Number(process.argv[3] ?? 8080);

new FroniusClient(host, port)
  .read()
  .then((d) => console.log(JSON.stringify(d, null, 2)))
  .catch((e) => {
    console.error("Fehler:", e.message);
    process.exit(1);
  });
