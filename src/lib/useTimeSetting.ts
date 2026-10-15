import { useEffect, useState } from "react";
import { client } from "../client";

/** Reads the `transaction_time_enabled` setting (default ON). Returns [enabled, loaded]. */
export function useTimeSetting(): [boolean, boolean] {
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    client
      .getSetting("transaction_time_enabled")
      .then((v) => { setEnabled(v !== "0"); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);
  return [enabled, loaded];
}
