import { f, table } from "@xano/sdk";

export const DEFAULT_DISCLOSURE = [
  "Before you sign, please read this. By agreeing, you consent to receive this document and to sign it electronically, and you agree that your electronic signature is the legal equivalent of your handwritten signature.",
  "You can ask the sender for a paper copy at any time, at no charge. You can withdraw this consent before you sign by declining the document; withdrawing doesn't affect anything you've already signed.",
  "To view and keep these records you need a device with a current web browser and a PDF reader. You'll be able to download the signed document once everyone has signed.",
  "If your email address changes, tell the sender so they can reach you.",
].join("\n\n");

/** The electronic records disclosure signers accept. The newest row is current; each signer's consent records the version they saw. */
export const disclosure = table({
  name: "disclosure",
  description: "Versions of the electronic records and signatures disclosure.",
  schema: {
    version: f.int({ required: true }),
    text: f.text({ required: true }),
    created_by: f.int(),
  },
  index: [{ type: "btree|unique", fields: [{ name: "version", op: "asc" }] }],
  seed: [{ version: 1, text: DEFAULT_DISCLOSURE, created_by: 0 }],
});
