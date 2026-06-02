import { useEffect, useState } from "react";
import { client } from "../client";

/** Reads the `transaction_time_enabled` setting (default OFF). Returns [enabled, loaded]. */
export function useTimeSetting(): [boolean, boolean] {
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    client
      .getSetting("transaction_time_enabled")
      .then((v) => { setEnabled(v === "1"); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);
  return [enabled, loaded];
}
