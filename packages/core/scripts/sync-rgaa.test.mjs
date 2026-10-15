import { describe, expect, it } from "vitest";
import { assertOnMain, isUnchanged } from "./sync-rgaa.mjs";

const b = (s) => Buffer.from(s);

describe("isUnchanged (mode --if-changed)", () => {
	it("vrai si les trois fichiers sont identiques octet pour octet", () => {
		expect(isUnchanged([b("a"), b("b"), b("c")], [b("a"), b("b"), b("c")])).toBe(true);
	});

	it("faux dès qu'un fichier diffère, même d'un octet d'espace", () => {
		expect(isUnchanged([b("a"), b("b"), b("c")], [b("a"), b("b "), b("c")])).toBe(false);
	});

	it("faux si un fichier de même longueur diffère d'un octet", () => {
		expect(isUnchanged([b("a"), b("x"), b("c")], [b("a"), b("y"), b("c")])).toBe(false);
	});

	it("faux si le nombre de fichiers diffère", () => {
		expect(isUnchanged([b("a"), b("b"), b("c")], [b("a"), b("b")])).toBe(false);
		expect(isUnchanged([b("a"), b("b")], [b("a"), b("b"), b("c")])).toBe(false);
	});

	it("faux si un fichier local est absent", () => {
		expect(isUnchanged([b("a"), b("b"), b("c")], [b("a"), null, b("c")])).toBe(false);
	});
});

describe("assertOnMain (provenance du commit DINUM)", () => {
	it.each(["identical", "behind"])("accepte un commit de main (%s)", (status) => {
		expect(() => assertOnMain(status, "abc")).not.toThrow();
	});

	it.each(["ahead", "diverged", undefined])("refuse un commit hors de main (%s)", (status) => {
		expect(() => assertOnMain(status, "abc")).toThrow(/abc/);
	});
});
