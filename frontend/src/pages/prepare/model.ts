// The prepare screen's working copy of a draft. Recipients and fields carry a local key, so a field keeps its owner while the
// people list is edited, and a save sends whole lists (the server makes the draft look exactly like them).
import type { Field, FieldType, IdentityCheck, PrepareView, Recipient, RecipientRole } from "@/lib/envelopes";

export type DraftPerson = {
  key: string; id?: number; name: string; email: string; role: RecipientRole; role_name: string; step: number;
  identity_check: IdentityCheck; access_code: string; has_access_code: boolean;
};
export type DraftField = Omit<Field, "id" | "recipient_id"> & { key: string; person: string };

let n = 0;
export const newKey = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export function peopleFrom(view: PrepareView): DraftPerson[] {
  return view.recipients.map((r: Recipient) => ({
    key: `r${r.id}`, id: r.id, name: r.name ?? "", email: r.email ?? "", role: r.role, role_name: r.role_name ?? "", step: r.step || 1,
    identity_check: r.identity_check, access_code: "", has_access_code: !!r.has_access_code,
  }));
}

export function fieldsFrom(view: PrepareView): DraftField[] {
  return view.fields.map((f) => ({
    key: `f${f.id}`, person: `r${f.recipient_id}`, type: f.type, page: f.page, x: Number(f.x), y: Number(f.y), w: Number(f.w), h: Number(f.h),
    required: f.required, label: f.label ?? "", options: Array.isArray(f.options) ? f.options : [], validation: f.validation && typeof f.validation === "object" ? f.validation : {},
  }));
}

export const blankPerson = (step: number): DraftPerson => ({
  key: newKey("p"), name: "", email: "", role: "signer", role_name: "", step, identity_check: "none", access_code: "", has_access_code: false,
});

/** The recipients list as the server takes it. A blank access code keeps the one already set. */
export const peoplePayload = (people: DraftPerson[], ordered: boolean) => people.map((p) => ({
  ...(p.id ? { id: p.id } : {}), name: p.name.trim(), email: p.email.trim(), role: p.role, role_name: p.role_name.trim(),
  step: ordered ? p.step : 1, identity_check: p.identity_check, ...(p.access_code.trim() ? { access_code: p.access_code.trim() } : {}),
}));

/** The fields list as the server takes it, with each owner's saved id. Fields whose owner isn't saved yet are held back. */
export const fieldsPayload = (fields: DraftField[], people: DraftPerson[]): Field[] => {
  const ids = new Map(people.filter((p) => p.id).map((p) => [p.key, p.id as number]));
  return fields.filter((f) => ids.has(f.person)).map(({ key: _k, person, ...f }) => ({ ...f, recipient_id: ids.get(person) as number }));
};

/** Steps run 1, 2, 3… with no gaps, in the order people appear. */
export function normaliseSteps(people: DraftPerson[]): DraftPerson[] {
  const used = [...new Set(people.map((p) => p.step))].sort((a, b) => a - b);
  const map = new Map(used.map((s, i) => [s, i + 1]));
  return people.map((p) => ({ ...p, step: map.get(p.step) ?? 1 }));
}

export const CAN_HAVE_FIELDS = (role: RecipientRole) => role !== "cc";
export const PALETTE: FieldType[] = ["signature", "initials", "date", "name", "email", "text", "number", "checkbox", "radio", "dropdown"];
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Who a person is on screen: their name, or on a template, their role ("Client"). */
export const whoIs = (p: Pick<DraftPerson, "name" | "role_name">) => p.name.trim() || p.role_name.trim() || "Unnamed";

/**
 * What's wrong with one person, in plain words, or "". On a template each row is a role: it needs a role name, and may name a
 * fixed person (both name and email) who's the same every time.
 */
export function personProblem(p: DraftPerson, template = false): string {
  if (template) {
    if (!p.role_name.trim()) return "Name the role, like Client or Manager.";
    if (p.name.trim() && !p.email.trim()) return "Add their email too, or leave both blank to fill them in each time.";
    if (p.email.trim() && !EMAIL.test(p.email.trim())) return "Check their email address.";
    if (p.email.trim() && !p.name.trim()) return "Add their name too, or leave both blank to fill them in each time.";
  } else {
    if (!p.name.trim()) return "Add their name.";
    if (!EMAIL.test(p.email.trim())) return "Check their email address.";
  }
  if (p.identity_check === "access_code" && !p.access_code.trim() && !p.has_access_code) return "Set the access code you'll give them.";
  if (p.access_code.trim() && (p.access_code.trim().length < 4 || p.access_code.trim().length > 40)) return "An access code needs 4 to 40 characters.";
  return "";
}
