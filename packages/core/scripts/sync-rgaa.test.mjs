import { describe, expect, it } from "vitest";
import { isUnchanged } from "./sync-rgaa.mjs";

const b = (s) => Buffer.from(s);

describe("isUnchanged (mode --if-changed)", () => {
	it("vrai si les trois fichiers sont identiques octet pour octet", () => {
		expect(isUnchanged([b("a"), b("b"), b("c")], [b("a"), b("b"), b("c")])).toBe(true);
	});

	it("faux dès qu'un fichier diffère, même d'un octet d'espace", () => {
		expect(isUnchanged([b("a"), b("b"), b("c")], [b("a"), b("b "), b("c")])).toBe(false);
	});

	it("faux si un fichier local est absent", () => {
		expect(isUnchanged([b("a"), b("b"), b("c")], [b("a"), null, b("c")])).toBe(false);
	});
});
