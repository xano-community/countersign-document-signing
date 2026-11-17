// The one place that writes email markup. Every value it places is HTML-escaped here, so a name like `<a href="x">` shows as
// those characters. Callers pass plain text only. The layout is a table, inline-styled, and reads fine with images off: the
// organisation's name is always text, the logo is a decoration, and the link is printed in full under the button.
import { c, defineFunction, expr, fl, inp, input, ref, s, withFilters, type Value } from "@xano/sdk";

/** Accent names the settings screen offers, as email-safe hex. A hex value (#1f3a5f) is used as given. */
export const ACCENTS = { ink: "#1f3a5f", forest: "#24553f", plum: "#5b2a5e", rust: "#9a3b1f", slate: "#3d4a5c", teal: "#1d5c63" } as const;
const DEFAULT_ACCENT = ACCENTS.ink;

/** HTML-escape text for an element body or a double-quoted attribute. Null becomes "". `&` goes first. */
export const esc = (v: Value) => withFilters(v, fl.first_notnull(c.text("")), fl.to_text(),
  fl.string_replace(c.text("&"), c.text("&amp;")),
  fl.string_replace(c.text("<"), c.text("&lt;")),
  fl.string_replace(c.text(">"), c.text("&gt;")),
  fl.string_replace(c.text("\""), c.text("&quot;")),
  fl.string_replace(c.text("'"), c.text("&#39;")));

const FONT = "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;";
const add = (...parts: (string | Value)[]) =>
  s.update_var("html", parts.reduce<Value>((acc, p) => withFilters(acc, fl.concat(typeof p === "string" ? c.text(p) : p)), ref("html")));
const when = (name: string, then: Parameters<typeof s.conditional>[0]["then"]) => s.conditional({ when: expr(ref(name), "!=", c.text("")), then });

export const layoutFn = defineFunction({
  name: "email/layout",
  description: "Render one branded email from plain-text parts. Escapes every value.",
  input: {
    org_name: input.text(), logo: input.text(), accent: input.text(),
    /** Shown by inboxes beside the subject; hidden in the body. */
    preheader: input.text(),
    heading: input.text(), intro: input.text(),
    /** The sender's own message, quoted. Line breaks are kept. */
    quote: input.text(), quote_label: input.text(),
    /** A one-time code, shown large. */
    code: input.text(),
    detail_label: input.text(), detail_value: input.text(),
    button_label: input.text(), url: input.text(),
    after: input.text(), footer: input.text(),
  },
  stack: [
    // Escaped once, up front: nothing below reads an input directly.
    s.set_var("e_org", esc(withFilters(inp("org_name"), fl.first_notempty(c.text("Countersign"))))),
    s.set_var("e_pre", esc(inp("preheader"))),
    s.set_var("e_heading", esc(inp("heading"))),
    s.set_var("e_intro", esc(inp("intro"))),
    s.set_var("e_quote", withFilters(esc(inp("quote")), fl.string_replace(c.text("\n"), c.text("<br>")))),
    s.set_var("e_quote_label", esc(inp("quote_label"))),
    s.set_var("e_code", esc(inp("code"))),
    s.set_var("e_detail_label", esc(inp("detail_label"))),
    s.set_var("e_detail_value", withFilters(esc(inp("detail_value")), fl.string_replace(c.text("\n"), c.text("<br>")))),
    s.set_var("e_button", esc(inp("button_label"))),
    s.set_var("e_after", esc(inp("after"))),
    s.set_var("e_footer", esc(inp("footer"))),
    // Only a web address becomes a link; anything else is dropped rather than placed in an href.
    s.set_var("url_in", withFilters(inp("url"), fl.first_notnull(c.text("")), fl.trim())),
    s.set_var("url_ok", withFilters(c.regex(/^https?:\/\/[^\s"'<>]+$/i), fl.regex_test(ref("url_in")))),
    s.set_var("e_url", c.text("")),
    s.conditional({ when: expr(ref("url_ok"), "=", c.bool(true)), then: [s.update_var("e_url", esc(ref("url_in")))] }),
    // A logo is only ever an image data URL.
    s.set_var("logo_in", withFilters(inp("logo"), fl.first_notnull(c.text("")), fl.trim())),
    s.set_var("logo_ok", withFilters(c.regex(/^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+\/=]+$/), fl.regex_test(ref("logo_in")))),
    s.set_var("e_logo", esc(ref("logo_in"))),
    s.set_var("accent_in", withFilters(inp("accent"), fl.first_notnull(c.text("")), fl.trim(), fl.lower())),
    s.set_var("accent", withFilters(c.obj(ACCENTS), fl.get(ref("accent_in"), c.text(DEFAULT_ACCENT)))),
    s.set_var("accent_hex", withFilters(c.regex(/^#[0-9a-f]{6}$/), fl.regex_test(ref("accent_in")))),
    s.conditional({ when: expr(ref("accent_hex"), "=", c.bool(true)), then: [s.update_var("accent", ref("accent_in"))] }),

    s.set_var("html", c.text("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>")),
    add(ref("e_heading"), "</title></head><body style=\"margin:0;padding:0;background:#f4f2ee;\">"),
    add("<div style=\"display:none;max-height:0;overflow:hidden;opacity:0;\">", ref("e_pre"), "</div>"),
    add("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:#f4f2ee;\"><tr><td align=\"center\" style=\"padding:32px 16px;\">"),
    add("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px;\">"),
    // Brand row: the logo when there is one, and the name always.
    add("<tr><td style=\"padding:0 4px 16px;", FONT, "font-size:15px;font-weight:600;color:#1c1b19;\">"),
    s.conditional({ when: expr(ref("logo_ok"), "=", c.bool(true)), then: [
      add("<img src=\"", ref("e_logo"), "\" alt=\"\" height=\"28\" style=\"height:28px;vertical-align:middle;margin-right:8px;border:0;\">"),
    ] }),
    add(ref("e_org"), "</td></tr>"),
    add("<tr><td style=\"background:#ffffff;border:1px solid #e4e0d8;border-top:4px solid ", ref("accent"), ";border-radius:8px;padding:32px;", FONT, "color:#1c1b19;\">"),
    when("e_heading", [add("<h1 style=\"margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:600;\">", ref("e_heading"), "</h1>")]),
    when("e_intro", [add("<p style=\"margin:0 0 16px;font-size:16px;line-height:1.5;\">", ref("e_intro"), "</p>")]),
    when("e_quote", [
      add("<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:0 0 16px;\"><tr><td style=\"border-left:3px solid #e4e0d8;padding:4px 0 4px 16px;font-size:15px;line-height:1.5;color:#45423d;\">"),
      when("e_quote_label", [add("<div style=\"font-size:13px;color:#6b665e;margin-bottom:4px;\">", ref("e_quote_label"), "</div>")]),
      add(ref("e_quote"), "</td></tr></table>"),
    ]),
    when("e_code", [add("<p style=\"margin:8px 0 24px;font-size:32px;letter-spacing:6px;font-weight:600;font-family:Menlo,Consolas,monospace;\">", ref("e_code"), "</p>")]),
    when("e_detail_value", [
      add("<p style=\"margin:0 0 16px;font-size:15px;line-height:1.5;\"><strong>", ref("e_detail_label"), "</strong><br>", ref("e_detail_value"), "</p>"),
    ]),
    when("e_url", [
      add("<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:8px 0 24px;\"><tr><td style=\"border-radius:6px;background:", ref("accent"), ";\">"),
      add("<a href=\"", ref("e_url"), "\" style=\"display:inline-block;padding:12px 22px;font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px;\">", ref("e_button"), "</a></td></tr></table>"),
      add("<p style=\"margin:0 0 16px;font-size:13px;line-height:1.5;color:#6b665e;\">If the button doesn't work, copy this link into your browser:<br><a href=\"", ref("e_url"), "\" style=\"color:#45423d;word-break:break-all;\">", ref("e_url"), "</a></p>"),
    ]),
    when("e_after", [add("<p style=\"margin:0;font-size:15px;line-height:1.5;color:#45423d;\">", ref("e_after"), "</p>")]),
    add("</td></tr>"),
    add("<tr><td style=\"padding:16px 4px 0;", FONT, "font-size:12px;line-height:1.5;color:#6b665e;\">", ref("e_footer"), "<br>Sent by ", ref("e_org"), " with Countersign.</td></tr>"),
    add("</table></td></tr></table></body></html>"),
  ],
  response: ref("html"),
});
