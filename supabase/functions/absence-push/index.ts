// =====================================================================
// Supabase Edge Function: absence-push
// Wysyła powiadomienia push o zgłoszeniach nieobecności. Wywołuje ją baza (sql/31_powiadomienia_push.sql)
// z nagłówkiem x-push-secret i treścią { request_id, event }.
//   event "new" / "cancelled"     -> mistrzowie działu pracownika (brak mistrza -> administratorzy)
//   event "approved" / "rejected" -> pracownik
//
// Wdrożenie (panel Supabase): Edge Functions -> Deploy a new function -> Via Editor,
// nazwa: absence-push, wklej ten plik, Deploy. Potem w ustawieniach funkcji WYŁĄCZ "Verify JWT"
// (funkcję chroni hasło x-push-secret).
// Sekrety (Edge Functions -> Secrets): VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, PUSH_HOOK_SECRET,
// VAPID_SUBJECT (np. mailto:adres@firma.pl). SUPABASE_URL i SUPABASE_SERVICE_ROLE_KEY są dostępne same.
// =====================================================================
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const REASONS: Record<string, string> = {
  urlop: "urlop",
  urlop_na_zadanie: "urlop na żądanie",
  l4: "L4",
  opieka: "opieka",
  inny: "inny powód",
};
const SHIFTS: Record<string, string> = {
  "06:30|14:30": "zmiana I",
  "14:30|22:30": "zmiana II",
  "22:30|06:30": "zmiana III",
};

const env = (name: string) => Deno.env.get(name) ?? "";

function pl(iso: string) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

function when(r: { date_from: string; date_to: string; time_from: string | null; time_to: string | null }) {
  const dates = r.date_from === r.date_to ? pl(r.date_from) : `${pl(r.date_from)}–${pl(r.date_to)}`;
  if (!r.time_from || !r.time_to) return `${dates}, cały dzień`;
  const shift = SHIFTS[`${r.time_from}|${r.time_to}`];
  return `${dates}, ${shift ?? `godz. ${r.time_from}–${r.time_to}`}`;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env("PUSH_HOOK_SECRET") || req.headers.get("x-push-secret") !== env("PUSH_HOOK_SECRET")) {
    return new Response("Forbidden", { status: 403 });
  }

  let body: { request_id?: number; event?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const event = String(body.event ?? "");
  if (!body.request_id || !["new", "cancelled", "approved", "rejected"].includes(event)) {
    return new Response("Bad request", { status: 400 });
  }

  const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });

  // Zgłoszenie z danymi pracownika i działu (stan z bazy, nie z wywołania)
  const { data: r, error } = await db
    .from("absence_requests")
    .select(`id, employee_id, department_id, date_from, date_to, time_from, time_to, reason, description, status, decision_note,
      employee:employee_id ( first_name, last_name ),
      department:department_id ( department )`)
    .eq("id", body.request_id)
    .maybeSingle();
  if (error || !r) return new Response("Not found", { status: 404 });

  const name = `${r.employee?.first_name ?? ""} ${r.employee?.last_name ?? ""}`.trim() || "Pracownik";
  const reason = REASONS[r.reason] ?? r.reason;

  // Odbiorcy i treść
  let subs: { id: number; endpoint: string; p256dh: string; auth: string }[] = [];
  let title = "", text = "", url = "./";

  if (event === "new" || event === "cancelled") {
    // mistrzowie działu (rola "Mistrz"), a gdy ich brak - administratorzy
    const { data: users } = await db
      .from("users")
      .select("id, department_id, role:role_id ( role )");
    const role = (u: { role?: { role?: string } | null }) => String(u.role?.role ?? "").trim().toLowerCase();
    let ids = (users ?? []).filter((u) => role(u) === "mistrz" && u.department_id === r.department_id).map((u) => u.id);
    if (!ids.length) ids = (users ?? []).filter((u) => role(u) === "administrator").map((u) => u.id);
    if (ids.length) {
      const { data } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", ids);
      subs = data ?? [];
    }
    title = event === "new" ? "Nowe zgłoszenie nieobecności" : "Zgłoszenie nieobecności anulowane";
    text = `${name}${r.department?.department ? ` (${r.department.department})` : ""}: ${when(r)} — ${reason}`;
    url = "./?view=absences";
  } else {
    const { data } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").eq("employee_id", r.employee_id);
    subs = data ?? [];
    title = event === "approved" ? "Nieobecność zaakceptowana" : "Nieobecność odrzucona";
    text = `${when(r)} — ${reason}${r.decision_note ? `. Komentarz: ${r.decision_note}` : ""}`;
    url = "./";
  }

  if (!subs.length) return Response.json({ sent: 0 });

  webpush.setVapidDetails(env("VAPID_SUBJECT") || "mailto:admin@example.com", env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
  const payload = JSON.stringify({ title, body: text, url, tag: `absence-${r.id}` });

  let sent = 0;
  const gone: number[] = [];
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 });
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) gone.push(s.id);      // urządzenie wyłączyło powiadomienia
      else console.error("Błąd wysyłki push:", code, (err as Error).message);
    }
  }));
  if (gone.length) await db.from("push_subscriptions").delete().in("id", gone);

  return Response.json({ sent, removed: gone.length });
});
