// Audit guidé (ADR-0013) : le seul îlot JavaScript du site. Modèle et opérations : @rampe/core/audit-session.
// Imports par sous-chemin : l'îlot n'embarque ni le référentiel ni axe-core, seulement les données reçues en props.
import {
	type ImportSummary,
	INVALID_REPORT,
	importAutomaticResults,
	MAX_REPORT_BYTES,
	parseAuditReport,
	ReportError,
} from "@rampe/core/audit-report";
import {
	ACTION_STATUSES,
	type AuditSession,
	addPage,
	createSession,
	type DeclarationField,
	getEvaluation,
	getFindings,
	INVALID_SESSION,
	isDay,
	isFutureSession,
	MAX_NOTE,
	MAX_PAGES,
	MAX_PROCESS,
	MAX_SECTION,
	MAX_SESSION_BYTES,
	MAX_TITLE,
	MAX_URL,
	PRIORITIES,
	parseSessionStrict,
	parseStoredSession,
	progress,
	type ResultKind,
	removePage,
	type SchemaAction,
	type SessionPage,
	type Status,
	serializeSession,
	sessionFileName,
	setDeclarationField,
	setEvaluation,
	setPageProcess,
} from "@rampe/core/audit-session";
import { type Conformity, computeConformity, formatRate, processKey } from "@rampe/core/conformity";
import {
	type Block,
	conformityState,
	DECLARATION_URL,
	declarationBlocks,
	declarationFileName,
	type Inline,
	NON_CONFORMITY_REASONS,
	renderDeclaration,
	SCOPE_URL,
	safeUrl,
} from "@rampe/core/declaration";
import { parseAuditUrl, parseSampleFile, plural } from "@rampe/core/sample-file";
import {
	type ActionPatch,
	actionState,
	addFreeAction,
	periodYears,
	planBlocks,
	planFileName,
	proposeActions,
	renderAnnualPlan,
	renderSchema,
	SCHEMA_MENTION,
	SCHEMA_URL,
	schemaBlocks,
	schemaFileName,
	setSchemaPeriod,
	setSchemaSection,
	updateAction,
	VOLETS,
} from "@rampe/core/schema";
import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";

/** Données du référentiel préparées au build (pages/audit/index.astro). Les champs `*Html` sont DÉJÀ assainis. */
export interface AuditTopic {
	number: number;
	title: string;
	intro: string;
}
export interface AuditCriterion {
	id: string;
	topic: number;
	titleHtml: string;
	/** Titre sans ses liens vers le glossaire, pour la liste (un lien ne peut pas être dans un bouton). */
	titleTextHtml: string;
	/** Titre officiel en texte brut, pour la déclaration d'accessibilité. */
	titleText: string;
	tests: { id: string; statementHtml: string; conditionsHtml: string[]; methodologyHtml: string }[];
	href: string;
}

type Filter = "all" | "NT" | "NC" | "auto";

const STORAGE_KEY = "rampe.audit.session";
/** Copies d'une session illisible mises de côté, chacune sous sa clé horodatée : jamais écrasées (ADR-0016). */
const IGNORED_PREFIX = `${STORAGE_KEY}.ignoree.`;
const MAX_IGNORED = 3;
const UNDONE = "Import annulé : l’audit est revenu à son état d’avant l’import.";
const SAVE_DELAY = 400;
const STATUS_LABELS: [Status, string][] = [
	["C", "Conforme"],
	["NC", "Non conforme"],
	["NA", "Non applicable"],
	["NT", "Non testé"],
];
/** Classes de résultat de la CLI (ADR-0011 §3), en clair pour un non-expert. */
const KIND_LABELS: Record<ResultKind, string> = {
	"non-conformite": "Non-conformité détectée",
	incertain: "Rattachement incertain",
	"a-verifier": "À vérifier",
	"bonne-pratique": "Bonne pratique",
};
const FILTERS: [Filter, string][] = [
	["all", "Tous les critères"],
	["NT", "Critères avec des pages non testées"],
	["NC", "Critères non conformes sur au moins une page"],
	["auto", "Critères avec des statuts détectés automatiquement, à confirmer"],
];

/**
 * Injecte du HTML produit AU BUILD par lib/render.ts (assainissement par liste blanche, ADR-0010 §5) à partir du
 * référentiel officiel. N'est JAMAIS appelé avec une donnée saisie par l'utilisateur : celles-ci passent toujours
 * par le texte JSX, échappé par Preact.
 */
const trustedBuildHtml = (html: string) => ({ dangerouslySetInnerHTML: { __html: html } });

// Stockage local (ADR-0013 §4) : absent, plein ou refusé selon le navigateur, d'où un try/catch sur chaque accès.
function storageAvailable(): boolean {
	try {
		const probe = `${STORAGE_KEY}.test`;
		localStorage.setItem(probe, "1");
		localStorage.removeItem(probe);
		return true;
	} catch {
		return false;
	}
}

/**
 * Relit une valeur du stockage : structure et types contrôlés, sans borne ni modification (ADR-0016), pour ne jamais
 * écarter un audit écrit par une version précédente ; `future` : écrite par une version plus récente de Rampe.
 */
function readStored(
	raw: string,
	known: ReadonlySet<string>,
	dropped: DeclarationField[] = [],
): { session: AuditSession | null; future: boolean } {
	let value: unknown;
	try {
		value = JSON.parse(raw);
		return { session: parseStoredSession(value, known, dropped), future: false };
	} catch {
		return { session: null, future: isFutureSession(value) };
	}
}

/**
 * Valeur illisible du stockage. `kept` : une copie existe dans le stockage, ou l'utilisateur a confirmé avoir enregistré
 * le fichier ; tant que ce n'est pas le cas, rien n'est écrit (`downloaded` : téléchargement lancé, à confirmer).
 */
type Ignored = { raw: string; kept: boolean; downloaded?: boolean };

/** Copies mises de côté (`<préfixe><n>.<ISO>`), dans l'ordre d'écriture `n` : jamais dans l'ordre de l'horloge. */
function asides(): { key: string; n: number }[] {
	return Object.keys(localStorage)
		.flatMap((key) => {
			const m = key.startsWith(IGNORED_PREFIX) ? /^(\d+)\./.exec(key.slice(IGNORED_PREFIX.length)) : null;
			return m ? [{ key, n: Number(m[1]) }] : [];
		})
		.sort((a, b) => a.n - b.n);
}

/**
 * Met `raw` de côté sous une nouvelle clé, sauf si une copie identique existe déjà (rechargements répétés). Au-delà de
 * 3 copies, les plus anciennes ÉCRITES sont retirées, jamais celle qu'on vient d'écrire. Vrai seulement si la copie
 * est relue intacte.
 */
function keepAside(raw: string): boolean {
	let list: { key: string; n: number }[];
	try {
		list = asides();
		if (list.some((a) => localStorage.getItem(a.key) === raw)) return true;
	} catch {
		return false;
	}
	const key = `${IGNORED_PREFIX}${(list.at(-1)?.n ?? 0) + 1}.${new Date().toISOString()}`;
	try {
		localStorage.setItem(key, raw);
	} catch {
		return false;
	}
	try {
		for (const old of list.slice(0, Math.max(0, list.length + 1 - MAX_IGNORED))) localStorage.removeItem(old.key);
	} catch {}
	try {
		return localStorage.getItem(key) === raw;
	} catch {
		return false;
	}
}

/**
 * `ignored` : une valeur était présente mais illisible ; elle est mise de côté, jamais réutilisée ni écrasée.
 * `future` : une version plus récente l'a écrite ; on n'y touche pas (ni mise de côté, ni écrasement).
 */
function loadSession(
	known: ReadonlySet<string>,
	dropped: DeclarationField[],
): {
	session: AuditSession | null;
	ignored: Ignored | null;
	future: boolean;
} {
	let raw: string | null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		return { session: null, ignored: null, future: false };
	}
	if (raw === null) return { session: null, ignored: null, future: false };
	const { session, future } = readStored(raw, known, dropped);
	if (session) return { session, ignored: null, future: false };
	if (future) return { session: null, ignored: null, future: true };
	return { session: null, ignored: { raw, kept: keepAside(raw) }, future: false };
}

/** Fichier fabriqué dans le navigateur (Blob et lien) : rien ne part sur le réseau. */
function saveFile(name: string, text: string, type = "application/json") {
	const a = document.createElement("a");
	a.href = URL.createObjectURL(new Blob([text], { type }));
	a.download = name;
	a.click();
	// Révocation différée : certains navigateurs lisent le Blob après le clic.
	setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function saveSession(session: AuditSession): boolean {
	try {
		localStorage.setItem(STORAGE_KEY, serializeSession(session));
		return true;
	} catch {
		return false;
	}
}

/** Adresse sans identifiants : on ne garde pas de mot de passe dans le stockage du navigateur. */
const cleanUrl = (input: string) => {
	const url = parseAuditUrl(input.trim());
	url.username = "";
	url.password = "";
	return url;
};
const sameUrl = (a: string, b: string) => a.split("#")[0] === b.split("#")[0];
const pageName = (p: SessionPage) => p.title.trim() || p.url;

export default function AuditApp({
	topics,
	criteria,
	rgaaVersion,
}: {
	topics: AuditTopic[];
	criteria: AuditCriterion[];
	rgaaVersion: string;
}) {
	const [session, setSession] = useState<AuditSession>(() => createSession());
	const [ready, setReady] = useState(false);
	const [storageOk, setStorageOk] = useState(true);
	const [saveFailed, setSaveFailed] = useState(false);
	const [ignored, setIgnored] = useState<Ignored | null>(null);
	/** Session d'une version plus récente dans le stockage : plus aucune écriture, pour ne pas l'écraser. */
	const [future, setFuture] = useState(false);
	/** Dates de déclaration illisibles retirées à la relecture : signalées sobrement, la session reste utilisée. */
	const [droppedDates, setDroppedDates] = useState(0);
	/** Plus aucune écriture : session d'une version future, ou session illisible qui n'a pas pu être copiée. */
	const frozen = future || (ignored !== null && !ignored.kept);
	/** `null` : aucun critère de la thématique ne correspond au filtre. */
	const [currentId, setCurrentId] = useState<string | null>(criteria[0]?.id ?? null);
	const [topicNumber, setTopicNumber] = useState(criteria[0]?.topic ?? 1);
	const [filter, setFilter] = useState<Filter>("all");
	const [announce, setAnnounce] = useState("");
	const narrow = useNarrow();
	const known = useMemo(() => new Set(criteria.map((c) => c.id)), [criteria]);
	const headingRef = useRef<HTMLHeadingElement>(null);
	/** Dernière session écrite ou relue : on n'écrit qu'après un vrai changement. */
	const saved = useRef<AuditSession>(session);
	const focusHeading = useRef(false);

	// Reprise de la session au chargement (côté client uniquement : le rendu du build part d'une session vide).
	useEffect(() => {
		const ok = storageAvailable();
		setStorageOk(ok);
		if (ok) {
			const dropped: DeclarationField[] = [];
			const { session: stored, ignored: wasIgnored, future: isFuture } = loadSession(known, dropped);
			setDroppedDates(dropped.length);
			if (stored) {
				saved.current = stored;
				setSession(stored);
			}
			setIgnored(wasIgnored);
			setFuture(isFuture);
		}
		setReady(true);
	}, []);

	// Sauvegarde automatique, différée pour ne pas écrire à chaque frappe. Un échec (stockage plein) n'arrête rien :
	// la modification suivante retente, et l'alerte disparaît dès qu'une écriture réussit.
	const pending = useRef<AuditSession | null>(null);
	useEffect(() => {
		if (!ready || !storageOk || frozen || session === saved.current) return;
		pending.current = session;
		const timer = setTimeout(() => {
			pending.current = null;
			if (saveSession(session)) {
				saved.current = session;
				setSaveFailed(false);
			} else {
				setSaveFailed(true);
				setAnnounce("Échec de l’enregistrement");
			}
		}, SAVE_DELAY);
		return () => clearTimeout(timer);
	}, [session, ready, storageOk, frozen]);
	// Fermeture de l'onglet pendant le délai : on écrit tout de suite.
	useEffect(() => {
		const flush = () => {
			if (pending.current) saveSession(pending.current);
		};
		addEventListener("pagehide", flush);
		return () => removeEventListener("pagehide", flush);
	}, []);
	// Un autre onglet a enregistré : on adopte son état (validé), sinon notre prochaine écriture l'effacerait.
	useEffect(() => {
		const onStorage = (e: StorageEvent) => {
			if (e.key !== STORAGE_KEY || e.newValue === null) return;
			const { session: other, future: isFuture } = readStored(e.newValue, known);
			if (isFuture) {
				pending.current = null;
				setFuture(true);
			}
			if (!other) return;
			pending.current = null;
			saved.current = other;
			setSession(other);
			setAnnounce("Audit mis à jour depuis un autre onglet");
		};
		addEventListener("storage", onStorage);
		return () => removeEventListener("storage", onStorage);
	}, []);

	useLayoutEffect(() => {
		if (focusHeading.current) {
			focusHeading.current = false;
			headingRef.current?.focus();
		}
	}, [currentId]);

	const prog = useMemo(() => progress(session, criteria), [session, criteria]);
	const ids = useMemo(() => criteria.map((c) => c.id), [criteria]);
	const conformity = useMemo(() => computeConformity(session, ids), [session, ids]);
	const matchesWith = (f: Filter) => (c: AuditCriterion) =>
		f === "all" ||
		session.pages.some((p) => {
			const e = getEvaluation(session, c.id, p.id);
			return f === "auto" ? e.source === "auto" : e.status === f;
		});
	const matches = matchesWith(filter);
	const index = criteria.findIndex((c) => c.id === currentId);
	const current = criteria[index];
	const prev = current && criteria.slice(0, index).findLast(matches);
	const next = current && criteria.slice(index + 1).find(matches);
	const topic = topics.find((t) => t.number === (current?.topic ?? topicNumber));
	const inTopic = criteria.filter((c) => c.topic === topic?.number && matches(c));

	const show = (c: AuditCriterion) => {
		setCurrentId(c.id);
		setTopicNumber(c.topic);
	};
	const goTo = (c: AuditCriterion) => {
		focusHeading.current = true;
		show(c);
		if (c.id === currentId) headingRef.current?.focus();
	};
	const topicLabel = (t: AuditTopic) => `Thématique ${t.number} « ${t.title} »`;
	const chooseTopic = (t: AuditTopic) => {
		const first = criteria.find((c) => c.topic === t.number && matches(c));
		setTopicNumber(t.number);
		setCurrentId(first?.id ?? null);
		setAnnounce(
			first
				? `${topicLabel(t)} : critère ${first.id} affiché`
				: `${topicLabel(t)} : aucun critère ne correspond au filtre`,
		);
	};
	const changeFilter = (f: Filter) => {
		setFilter(f);
		const ok = matchesWith(f);
		const n = criteria.filter(ok).length;
		let message = `${plural(n, "critère")} affiché${n > 1 ? "s" : ""}`;
		if (!current || !ok(current)) {
			// Le critère affiché sort du filtre : premier critère correspondant de la thématique, sinon rien.
			const first = criteria.find((c) => c.topic === topic?.number && ok(c));
			setCurrentId(first?.id ?? null);
			if (first) message += ` ; critère ${first.id} affiché`;
		}
		setAnnounce(message);
	};
	const restart = () => {
		if (
			!confirm(
				"Effacer toutes les pages, toutes les évaluations, la déclaration et le schéma pluriannuel de cet audit ? Cette action est définitive.",
			)
		)
			return;
		setSession(createSession());
		const first = criteria[0];
		if (first) show(first);
		setAnnounce("Audit effacé : vous repartez de zéro.");
	};

	/** Raccourci depuis le résultat ou la déclaration : filtre, puis premier critère concerné. */
	const showMissing = (f: "NT" | "auto") => {
		setFilter(f);
		const first = criteria.find(matchesWith(f));
		if (first) goTo(first);
		const n = criteria.filter(matchesWith(f)).length;
		setAnnounce(`${plural(n, "critère")} affiché${n > 1 ? "s" : ""}${first ? ` ; critère ${first.id} affiché` : ""}`);
	};

	const criteriaList = (
		<ul>
			{inTopic.map((c) => (
				<li key={c.id}>
					<button type="button" aria-current={c.id === currentId ? "true" : undefined} onClick={() => goTo(c)}>
						<span class="audit-num">{c.id}</span>
						<span {...trustedBuildHtml(c.titleTextHtml)} />
						<CriterionSummary session={session} id={c.id} />
					</button>
				</li>
			))}
		</ul>
	);
	const listTitle = `Critères de la thématique ${topic?.number ?? ""}${filter !== "all" ? " (filtrés)" : ""}`;

	return (
		<div class="audit">
			{!storageOk && (
				<p class="audit-banner">
					<strong>Votre travail ne sera pas conservé si vous fermez cette page.</strong> Le stockage local de ce
					navigateur est indisponible (navigation privée, stockage plein ou refusé).
				</p>
			)}
			{saveFailed && (
				<p class="audit-banner" role="alert">
					<strong>Échec de l’enregistrement.</strong> Le stockage de ce navigateur est plein ou refusé : vos dernières
					modifications ne sont pas conservées. Rampe réessaie à chaque modification.
				</p>
			)}
			{future && (
				<p class="audit-banner" role="alert">
					<strong>Cet audit a été créé par une version plus récente de Rampe : rechargez la page.</strong> Tant que la
					page n’est pas rechargée, vos modifications ne sont pas enregistrées, pour ne pas abîmer cet audit.
				</p>
			)}
			{ignored && (
				<div class="audit-banner" role={ignored.kept ? undefined : "alert"}>
					<p>
						{ignored.kept ? (
							"Une session enregistrée n’a pas pu être relue (format inconnu ou abîmé) : elle a été mise de côté dans ce navigateur, sans être effacée, et un nouvel audit commence."
						) : (
							<strong>
								Une session enregistrée n’a pas pu être relue, ni mise de côté (stockage plein) : téléchargez-la,
								vérifiez que le fichier est bien enregistré, puis confirmez. D’ici là, vos modifications ne sont pas
								enregistrées, pour ne pas l’effacer.
							</strong>
						)}
					</p>
					<button
						type="button"
						onClick={() => {
							const name = `session-mise-de-cote-${new Date().toISOString().slice(0, 10)}.json`;
							saveFile(name, ignored.raw);
							// Aucune preuve que le fichier est enregistré (téléchargement annulable) : le gel reste.
							if (!ignored.kept) setIgnored({ ...ignored, downloaded: true });
							setAnnounce(`Session mise de côté téléchargée : ${name}`);
						}}
					>
						Télécharger la session mise de côté
					</button>
					{!ignored.kept && ignored.downloaded && (
						<button type="button" onClick={() => setIgnored({ ...ignored, kept: true })}>
							J’ai bien enregistré le fichier, continuer
						</button>
					)}
				</div>
			)}

			{droppedDates > 0 && (
				<p class="audit-help">
					Déclaration d’accessibilité : {plural(droppedDates, "date")} illisible{droppedDates > 1 ? "s" : ""}, retirée
					{droppedDates > 1 ? "s" : ""} à la relecture (section 4). Le reste de l’audit est intact.
				</p>
			)}

			<Backup session={session} setSession={setSession} setAnnounce={setAnnounce} known={known} />

			<Pages session={session} setSession={setSession} setAnnounce={setAnnounce}>
				<ImportReport session={session} setSession={setSession} setAnnounce={setAnnounce} known={known} />
			</Pages>

			<section aria-labelledby="audit-criteres" class="audit-eval">
				<h2 id="audit-criteres">2. Évaluer les critères</h2>
				{session.pages.length > 0 ? (
					<p class="audit-progress">
						<label for="audit-avancement">
							Il reste {plural(prog.total.remaining, "évaluation")} « non testé » sur {prog.total.total}
						</label>
						<progress id="audit-avancement" max={prog.total.total} value={prog.total.total - prog.total.remaining} />
						{prog.total.toConfirm > 0 && (
							<span class="audit-to-confirm">
								Dont {plural(prog.total.toConfirm, "statut")} détecté{prog.total.toConfirm > 1 ? "s" : ""}{" "}
								automatiquement, à confirmer.
							</span>
						)}
					</p>
				) : (
					<p class="audit-empty">
						Ajoutez au moins une page à l’échantillon pour évaluer les critères. Vous pouvez déjà parcourir les critères
						ci-dessous.
					</p>
				)}

				<fieldset class="audit-filter">
					<legend>Afficher</legend>
					{FILTERS.map(([value, label]) => (
						<label key={value}>
							<input
								type="radio"
								name="audit-filtre"
								value={value}
								checked={filter === value}
								onChange={() => changeFilter(value)}
							/>{" "}
							{label}
						</label>
					))}
				</fieldset>

				<nav aria-labelledby="audit-thematiques" class="audit-topics">
					<h3 id="audit-thematiques">Thématiques</h3>
					<ul>
						{topics.map((t) => {
							const count = prog.byTopic[t.number];
							return (
								<li key={t.number}>
									<button
										type="button"
										aria-current={t.number === topic?.number ? "true" : undefined}
										onClick={() => chooseTopic(t)}
									>
										{t.number}. {t.title}
										{count && count.total > 0 && (
											<span class="audit-count">
												{count.remaining === 0 ? "terminé" : `${count.remaining} à évaluer`}
											</span>
										)}
									</button>
								</li>
							);
						})}
					</ul>
				</nav>

				{inTopic.length > 0 &&
					(narrow ? (
						// Petit écran : la liste est repliée pour que le critère reste proche (revue de la PR #15).
						<details class="audit-list">
							<summary>{listTitle}</summary>
							<nav aria-label={listTitle}>{criteriaList}</nav>
						</details>
					) : (
						<nav aria-labelledby="audit-liste" class="audit-list">
							<h3 id="audit-liste">{listTitle}</h3>
							{criteriaList}
						</nav>
					))}

				{current && topic ? (
					<article class="audit-criterion" aria-labelledby="audit-titre">
						<h3 id="audit-titre" ref={headingRef} tabIndex={-1}>
							<span class="audit-num">
								Critère {current.id}, thématique {topic.number} « {topic.title} »
							</span>{" "}
							<span {...trustedBuildHtml(current.titleHtml)} />
						</h3>
						<p class="audit-official">
							Texte officiel du RGAA. <a href={current.href}>Fiche complète du critère {current.id}</a>
						</p>
						<div class="rampe-note">
							<p class="label">Explication Rampe — non normative (thématique « {topic.title} »)</p>
							<p>{topic.intro}</p>
						</div>

						{session.pages.length > 0 && (
							<div class="audit-pages-eval">
								<h4>Statut par page</h4>
								<p class="audit-help">
									Non applicable : le contenu visé par ce critère n’existe pas sur la page. Non testé : pas encore
									vérifié — un critère non testé empêche de conclure.
								</p>
								{session.pages.map((p) => (
									<PageEvaluation
										key={`${current.id}-${p.id}`}
										criterionId={current.id}
										page={p}
										session={session}
										setSession={setSession}
										setAnnounce={setAnnounce}
									/>
								))}
							</div>
						)}

						<details>
							<summary>Tests du critère {current.id}</summary>
							{current.tests.map((t) => (
								<div class="audit-test" key={t.id}>
									<h4>Test {t.id}</h4>
									<p {...trustedBuildHtml(t.statementHtml)} />
									{t.conditionsHtml.length > 0 && (
										<ul>
											{t.conditionsHtml.map((html) => (
												<li key={html} {...trustedBuildHtml(html)} />
											))}
										</ul>
									)}
									{t.methodologyHtml && (
										<details>
											<summary>Méthodologie du test {t.id}</summary>
											<div {...trustedBuildHtml(t.methodologyHtml)} />
										</details>
									)}
								</div>
							))}
						</details>

						<nav aria-label="Critères voisins" class="audit-pager">
							{prev && (
								<button type="button" onClick={() => goTo(prev)}>
									Critère précédent : {prev.id}
								</button>
							)}
							{next && (
								<button type="button" class="audit-next" onClick={() => goTo(next)}>
									Critère suivant : {next.id}
								</button>
							)}
						</nav>
					</article>
				) : (
					<p class="audit-none">Aucun critère ne correspond à ce filtre dans cette thématique.</p>
				)}
			</section>

			<Result session={session} criteria={criteria} r={conformity} showMissing={showMissing} />

			<Declaration
				session={session}
				setSession={setSession}
				setAnnounce={setAnnounce}
				criteria={criteria}
				r={conformity}
				rgaaVersion={rgaaVersion}
			/>

			<Schema session={session} setSession={setSession} setAnnounce={setAnnounce} criteria={criteria} r={conformity} />

			<p aria-live="polite" class="audit-live">
				{announce}
			</p>

			<section aria-labelledby="audit-recommencer" class="audit-restart">
				<h2 id="audit-recommencer">Recommencer</h2>
				<p>
					Le travail est enregistré dans ce navigateur uniquement : rien n’est envoyé à Rampe. Changer de navigateur ou
					effacer ses données fait perdre l’audit.
				</p>
				<button type="button" onClick={restart}>
					Effacer cet audit et recommencer
				</button>
			</section>
		</div>
	);
}

/** Vrai sous 700 px de large. Le rendu du build suppose un grand écran ; corrigé à l'hydratation. */
function useNarrow(): boolean {
	const [narrow, setNarrow] = useState(false);
	useEffect(() => {
		const query = matchMedia("(max-width: 699px)");
		const update = () => setNarrow(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	return narrow;
}

function CriterionSummary({ session, id }: { session: AuditSession; id: string }) {
	if (session.pages.length === 0) return null;
	const statuses = session.pages.map((p) => getEvaluation(session, id, p.id).status);
	const nc = statuses.filter((s) => s === "NC").length;
	const nt = statuses.filter((s) => s === "NT").length;
	const auto = session.pages.filter((p) => getEvaluation(session, id, p.id).source === "auto").length;
	const parts = [
		nc > 0 && `${nc} non conforme${nc > 1 ? "s" : ""}`,
		nt > 0 && `${nt} non testé${nt > 1 ? "s" : ""}`,
		auto > 0 && `${auto} à confirmer`,
	];
	return <span class="audit-count">{parts.filter(Boolean).join(", ") || "évalué"}</span>;
}

function PageEvaluation({
	criterionId,
	page,
	session,
	setSession,
	setAnnounce,
}: {
	criterionId: string;
	page: SessionPage;
	session: AuditSession;
	setSession: (update: (s: AuditSession) => AuditSession) => void;
	setAnnounce: (message: string) => void;
}) {
	const groupRef = useRef<HTMLFieldSetElement>(null);
	const evaluation = getEvaluation(session, criterionId, page.id);
	const findings = getFindings(session, criterionId, page.id);
	const noteId = `note-${criterionId}-${page.id}`;
	const update = (patch: { status?: Status; note?: string }) =>
		setSession((s) => setEvaluation(s, criterionId, page.id, patch));
	const label = STATUS_LABELS.find(([s]) => s === evaluation.status)?.[1] ?? "";
	/** Garde le statut détecté et le fait sien : le bouton disparaît, le focus va sur le statut coché. */
	const confirmAuto = () => {
		update({});
		groupRef.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
		setAnnounce(`Statut « ${label} » confirmé pour ${pageName(page)}, critère ${criterionId}`);
	};
	const conflict = evaluation.status === "C" && findings.some((f) => f.kind === "non-conformite");
	return (
		<fieldset class="audit-page" ref={groupRef}>
			<legend>
				<span class="visually-hidden">Critère {criterionId}, page </span>
				{pageName(page)}
				{page.title.trim() && <span class="audit-url"> ({page.url})</span>}
			</legend>
			{evaluation.source === "auto" && (
				<div class="audit-auto">
					<p>
						<strong>Détecté automatiquement, à confirmer.</strong> Vérifiez sur la page, puis confirmez ce statut ou
						choisissez-en un autre : il comptera alors comme votre évaluation.
					</p>
					<button type="button" onClick={confirmAuto}>
						Confirmer « {label} »<span class="visually-hidden"> pour {pageName(page)}</span>
					</button>
				</div>
			)}
			{conflict && (
				<p class="audit-conflict">
					<strong>L’outil a détecté une non-conformité sur cette page : vérifiez votre évaluation.</strong>
				</p>
			)}
			<div class="audit-statuses">
				{STATUS_LABELS.map(([status, label]) => (
					<label key={status} class={`audit-status audit-status-${status}`}>
						<input
							type="radio"
							name={`statut-${criterionId}-${page.id}`}
							value={status}
							checked={evaluation.status === status}
							onChange={() => update({ status })}
						/>{" "}
						{label}
					</label>
				))}
			</div>
			<label for={noteId}>Note sur {pageName(page)} (facultative)</label>
			<textarea
				id={noteId}
				rows={2}
				maxLength={Math.max(MAX_NOTE, evaluation.note.length)}
				value={evaluation.note}
				onInput={(e) => update({ note: e.currentTarget.value })}
			/>
			{findings.length > 0 && (
				<details class="audit-findings">
					<summary>
						Indices de l’audit automatique pour {pageName(page)} ({findings.length})
					</summary>
					<ul>
						{findings.map((f) => (
							<li key={`${f.kind}-${f.ruleId}`}>
								<strong>{KIND_LABELS[f.kind]}</strong> : règle <code>{f.ruleId}</code>
								{f.help && (
									<>
										{" "}
										« <span lang="en">{f.help}</span> »
									</>
								)}
								, {plural(f.nodes, "élément")} concerné{f.nodes > 1 ? "s" : ""}
							</li>
						))}
					</ul>
					<p class="audit-help">
						Un indice aide à chercher, il ne décide pas : seule une non-conformité détectée est certaine. Rattachement
						incertain : un problème existe, mais il ne relève peut-être pas de ce critère. À vérifier : l’outil n’a pas
						pu trancher. Bonne pratique : conseil, hors conformité.
					</p>
				</details>
			)}
		</fieldset>
	);
}

function Pages({
	session,
	setSession,
	setAnnounce,
	children,
}: {
	session: AuditSession;
	setSession: (update: AuditSession | ((s: AuditSession) => AuditSession)) => void;
	setAnnounce: (message: string) => void;
	children: ComponentChildren;
}) {
	const [url, setUrl] = useState("");
	const [title, setTitle] = useState("");
	const [urlError, setUrlError] = useState("");
	const [sample, setSample] = useState("");
	const [sampleMessage, setSampleMessage] = useState<{ error: boolean; text: string } | null>(null);
	const urlRef = useRef<HTMLInputElement>(null);
	const sampleRef = useRef<HTMLTextAreaElement>(null);
	const listRef = useRef<HTMLOListElement>(null);
	const headingRef = useRef<HTMLHeadingElement>(null);
	/** Après « Retirer » : position du bouton qui doit recevoir le focus (le suivant, sinon le précédent). */
	const focusAfterRemove = useRef<number | null>(null);
	useLayoutEffect(() => {
		const i = focusAfterRemove.current;
		if (i === null) return;
		focusAfterRemove.current = null;
		const buttons = listRef.current?.querySelectorAll("button") ?? [];
		const target = buttons[Math.min(i, buttons.length - 1)];
		(target ?? headingRef.current)?.focus();
	});

	/** Contrôle commun à la saisie et au collage : http(s), un seul site, pas de doublon. */
	const check = (s: AuditSession, u: URL): string | null => {
		// Bornes à l'écriture (ADR-0016) : la même définition que l'import, pour que l'audit se réimporte.
		if (u.href.length > MAX_URL)
			return `Adresse trop longue (plus de ${MAX_URL.toLocaleString("fr-FR")} caractères une fois encodée) : Rampe ne peut pas la garder.`;
		if (s.pages.length >= MAX_PAGES)
			return `L’échantillon compte déjà ${MAX_PAGES.toLocaleString("fr-FR")} pages : c’est le maximum.`;
		if (s.site && u.origin !== s.site)
			return `Cette adresse n’est pas sur le site audité (${s.site}). Un audit porte sur un seul site.`;
		if (s.pages.some((p) => sameUrl(p.url, u.href))) return "Cette page est déjà dans l’échantillon.";
		return null;
	};

	const submitPage = (e: Event) => {
		e.preventDefault();
		let error: string | null;
		let u: URL | null = null;
		try {
			u = cleanUrl(url);
			error = check(session, u);
		} catch (err) {
			error = url.trim() ? (err as Error).message : "Indiquez l’adresse de la page, par exemple https://exemple.fr/.";
		}
		if (error || !u) {
			setUrlError(error ?? "");
			urlRef.current?.focus();
			return;
		}
		const added = u.href;
		setSession((s) => addPage(s, { url: added, title: title.trim() }));
		setUrl("");
		setTitle("");
		setUrlError("");
		setAnnounce(`Page ajoutée : ${title.trim() || added}`);
		urlRef.current?.focus();
	};

	const importSample = () => {
		let next = session;
		const skipped: string[] = [];
		let warnings: string[];
		try {
			const parsed = parseSampleFile(sample);
			warnings = parsed.warnings;
			for (const raw of parsed.urls) {
				const u = cleanUrl(raw.href);
				const error = check(next, u);
				if (error) skipped.push(`${u.href} : ${error}`);
				else next = addPage(next, { url: u.href, title: "" });
			}
		} catch (err) {
			setSampleMessage({ error: true, text: (err as Error).message });
			sampleRef.current?.focus();
			return;
		}
		const added = next.pages.length - session.pages.length;
		setSession(next);
		setSample("");
		const text = [`${plural(added, "page")} ajoutée${added > 1 ? "s" : ""}.`, ...warnings, ...skipped].join(" ");
		setSampleMessage({ error: false, text });
		setAnnounce(text);
	};

	const remove = (p: SessionPage) => {
		if (!confirm(`Retirer « ${pageName(p)} » de l’échantillon ? Ses évaluations seront effacées.`)) return;
		focusAfterRemove.current = session.pages.indexOf(p);
		setSession((s) => removePage(s, p.id));
		setAnnounce(`Page retirée : ${pageName(p)}`);
	};

	return (
		<section aria-labelledby="audit-echantillon" class="audit-sample">
			<h2 id="audit-echantillon" ref={headingRef} tabIndex={-1}>
				1. Pages de l’échantillon
			</h2>
			{session.pages.length > 0 && (
				<p id="audit-processus-aide" class="audit-help">
					Processus : donnez le même nom aux pages d’un même parcours, par ex. « Commande ». Un critère n’y est validé
					que s’il l’est sur toutes les pages du parcours.
				</p>
			)}
			{session.pages.length > 0 ? (
				<ol class="audit-page-list" ref={listRef}>
					{session.pages.map((p) => (
						<li key={p.id}>
							<span>
								{pageName(p)}
								{p.title.trim() && <span class="audit-url"> {p.url}</span>}
							</span>
							<span class="audit-process">
								<label for={`processus-${p.id}`}>
									Processus (facultatif)<span class="visually-hidden"> de {pageName(p)}</span>
								</label>
								<input
									id={`processus-${p.id}`}
									type="text"
									maxLength={Math.max(MAX_PROCESS, p.process?.length ?? 0)}
									value={p.process ?? ""}
									aria-describedby="audit-processus-aide"
									onInput={(e) => {
										const value = e.currentTarget.value;
										setSession((s) => setPageProcess(s, p.id, value));
									}}
								/>
							</span>
							<button type="button" onClick={() => remove(p)}>
								Retirer<span class="visually-hidden"> {pageName(p)}</span>
							</button>
						</li>
					))}
				</ol>
			) : (
				<p>
					Aucune page pour l’instant. La méthode RGAA demande au moins l’accueil, le contact, les mentions légales, la
					déclaration d’accessibilité et des pages représentatives du site.
				</p>
			)}

			<form onSubmit={submitPage} noValidate class="audit-add">
				<h3>Ajouter une page</h3>
				<div class="audit-field">
					<label for="audit-url">Adresse de la page</label>
					<input
						id="audit-url"
						ref={urlRef}
						type="url"
						inputMode="url"
						autoComplete="url"
						value={url}
						onInput={(e) => setUrl(e.currentTarget.value)}
						aria-invalid={urlError ? "true" : undefined}
						aria-describedby={urlError ? "audit-url-erreur" : undefined}
					/>
					{urlError && (
						<p id="audit-url-erreur" class="audit-error">
							{urlError}
						</p>
					)}
				</div>
				<div class="audit-field">
					<label for="audit-titre-page">Nom de la page (facultatif)</label>
					<input
						id="audit-titre-page"
						type="text"
						maxLength={MAX_TITLE}
						value={title}
						onInput={(e) => setTitle(e.currentTarget.value)}
					/>
				</div>
				<button type="submit">Ajouter la page</button>
			</form>

			<details class="audit-paste">
				<summary>Coller un fichier echantillon.txt de la commande rampe echantillon</summary>
				<label for="audit-fichier">Contenu du fichier (une adresse par ligne, lignes en # ignorées)</label>
				<textarea
					id="audit-fichier"
					ref={sampleRef}
					rows={6}
					value={sample}
					onInput={(e) => setSample(e.currentTarget.value)}
					aria-invalid={sampleMessage?.error ? "true" : undefined}
					aria-describedby={sampleMessage ? "audit-fichier-message" : undefined}
				/>
				{sampleMessage && (
					<p id="audit-fichier-message" class={sampleMessage.error ? "audit-error" : undefined}>
						{sampleMessage.text}
					</p>
				)}
				<button type="button" onClick={importSample}>
					Ajouter ces pages
				</button>
			</details>
			{children}
		</section>
	);
}

/**
 * Import d'un rapport JSON de la CLI (ADR-0014). Taille contrôlée avant lecture, `JSON.parse` seul, validation stricte
 * tout ou rien dans @rampe/core ; « Annuler cet import » restaure l'état précédent tant que rien d'autre n'a changé.
 */
function ImportReport({
	session,
	setSession,
	setAnnounce,
	known,
}: {
	session: AuditSession;
	setSession: (update: AuditSession) => void;
	setAnnounce: (message: string) => void;
	known: ReadonlySet<string>;
}) {
	const imp = useFileImport<ImportSummary>(session, setSession, setAnnounce, MAX_REPORT_BYTES);
	const { error, done, undone, inputRef } = imp;

	const onChange = (e: Event) =>
		imp.read(
			e,
			"Ce fichier n’est pas un fichier JSON lisible : choisissez le fichier écrit par rampe audit --json. Rien n’a été importé.",
			(json, before) => {
				let result: ReturnType<typeof importAutomaticResults>;
				try {
					result = importAutomaticResults(before, parseAuditReport(json, known));
				} catch (err) {
					if (err instanceof ReportError) return imp.refuse(err.message, err.detail);
					return imp.refuse(INVALID_REPORT, (err as Error).message);
				}
				imp.apply(before, result.session, result.summary, summaryText(result.summary));
			},
		);

	return (
		<div class="audit-import">
			<h3>Rapport de la CLI : reprendre les résultats de l’audit automatique</h3>
			<p id="audit-rapport-aide">
				Fichier écrit par <code>rampe audit --json</code> (20 Mo au plus). Les pages manquantes sont ajoutées. Les
				non-conformités détectées sont proposées « à confirmer » sur les critères encore non testés ; les autres
				résultats deviennent des indices. Vos évaluations déjà saisies ne sont jamais modifiées. Pour reprendre un audit
				complet téléchargé depuis Rampe, utilisez plutôt « Importer un audit (JSON) », section « Sauvegarde de l’audit
				».
			</p>
			<label for="audit-rapport">Importer un rapport de la CLI (JSON)</label>
			<input
				id="audit-rapport"
				ref={inputRef}
				type="file"
				accept="application/json,.json"
				onChange={onChange}
				aria-invalid={error ? "true" : undefined}
				aria-describedby={error ? "audit-rapport-aide audit-rapport-erreur" : "audit-rapport-aide"}
			/>
			{error && <ImportError id="audit-rapport-erreur" error={error} />}
			{undone && <p>{UNDONE}</p>}
			{done && (
				<div class="audit-import-summary">
					<p>{summaryText(done.summary)}</p>
					<ul>
						<li>Pages ajoutées à l’échantillon : {done.summary.pagesAdded}</li>
						<li>Critères marqués « Non conforme », à confirmer : {done.summary.statusesSet}</li>
						<li>Indices ajoutés sous les critères : {done.summary.findingsAdded}</li>
						{done.summary.pagesSkipped.map((p) => (
							<li key={p.url}>
								Page non importée, en erreur dans le rapport : <span class="audit-url">{p.url}</span> ({p.reason})
							</li>
						))}
					</ul>
					{imp.canUndo && (
						<button type="button" onClick={imp.undo}>
							Annuler cet import
						</button>
					)}
				</div>
			)}
		</div>
	);
}

type ImportFailure = { message: string; detail?: string };

/** Phrase claire d'abord ; le premier défaut trouvé suit, replié (ADR-0014 §4, ADR-0016 §2). */
function ImportError({ id, error }: { id: string; error: ImportFailure }) {
	return (
		<div id={id} class="audit-error">
			<p>{error.message}</p>
			{error.detail && (
				<details>
					<summary>Détail technique</summary>
					<p>{error.detail}</p>
				</details>
			)}
		</div>
	);
}

/**
 * Import d'un fichier JSON, commun au rapport de la CLI et à l'audit complet : taille vérifiée avant lecture,
 * `JSON.parse` seul, puis « Annuler cet import » (ADR-0014 §5, ADR-0016 §3), qui restaure l'état d'avant tant que
 * rien d'autre n'a changé.
 */
function useFileImport<S>(
	session: AuditSession,
	setSession: (update: AuditSession) => void,
	setAnnounce: (message: string) => void,
	maxBytes: number,
) {
	const [error, setError] = useState<ImportFailure | null>(null);
	const [done, setDone] = useState<{ summary: S; before: AuditSession; after: AuditSession } | null>(null);
	const [undone, setUndone] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	// La lecture du fichier est asynchrone : l'import part de la session à jour à ce moment-là.
	const latest = useRef(session);
	latest.current = session;
	const refuse = (message: string, detail?: string) => {
		setError({ message, detail });
		setDone(null);
		setUndone(false);
		setAnnounce(message);
	};
	return {
		error,
		done,
		undone,
		inputRef,
		latest,
		refuse,
		canUndo: done !== null && session === done.after,
		/** Lit le fichier choisi ; `unreadable` : message d'un JSON illisible. */
		async read(e: Event, unreadable: string, use: (json: unknown, current: AuditSession) => void) {
			const input = e.currentTarget as HTMLInputElement;
			const file = input.files?.[0];
			input.value = ""; // le même fichier peut être choisi à nouveau
			if (!file) return;
			if (file.size > maxBytes)
				return refuse(
					`Fichier trop volumineux (${Math.ceil(file.size / 1024 / 1024)} Mo) : ${maxBytes / 1024 / 1024} Mo au plus. Rien n’a été importé.`,
				);
			let json: unknown;
			try {
				json = JSON.parse(await file.text());
			} catch {
				return refuse(unreadable);
			}
			use(json, latest.current);
		},
		apply(before: AuditSession, after: AuditSession, summary: S, message: string) {
			setSession(after);
			setError(null);
			setUndone(false);
			setDone({ summary, before, after });
			setAnnounce(message);
		},
		undo() {
			if (!done) return;
			setSession(done.before);
			setDone(null);
			setUndone(true);
			setAnnounce(UNDONE);
			inputRef.current?.focus();
		},
	};
}

const dateTime = (iso: string) => new Date(iso).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" });

/**
 * Sauvegarde (ADR-0016) : téléchargement de l'audit complet en JSON, sans réseau, et import d'un audit téléchargé.
 * Importer remplace l'audit en cours : s'il a des pages (donc d'éventuelles évaluations, qui n'existent pas sans
 * page), une boîte de dialogue native demande confirmation et propose d'abord de télécharger l'audit en cours.
 */
function Backup({
	session,
	setSession,
	setAnnounce,
	known,
}: {
	session: AuditSession;
	setSession: (update: AuditSession) => void;
	setAnnounce: (message: string) => void;
	known: ReadonlySet<string>;
}) {
	const imp = useFileImport<{ pages: number; evaluations: number; findings: number }>(
		session,
		setSession,
		setAnnounce,
		MAX_SESSION_BYTES,
	);
	const { error, done, undone, inputRef, latest } = imp;
	const dialogRef = useRef<HTMLDialogElement>(null);
	/** Audit validé en attente de confirmation ; `downloaded` : nom du fichier téléchargé depuis la boîte de dialogue. */
	const [pending, setPending] = useState<AuditSession | null>(null);
	const [downloaded, setDownloaded] = useState("");
	useEffect(() => {
		if (pending && !dialogRef.current?.open) dialogRef.current?.showModal();
	}, [pending]);

	/** Problème d'un audit hérité d'une version précédente, au-delà des bornes d'import (ADR-0016). */
	const [legacy, setLegacy] = useState<ImportFailure | null>(null);
	const download = () => {
		const at = new Date();
		const next = { ...latest.current, exportedAt: at.toISOString() };
		const name = sessionFileName(next, at);
		const text = serializeSession(next);
		saveFile(name, text);
		setSession(next);
		// Un audit écrit par une version précédente peut dépasser les bornes d'import : on le dit, sans bloquer.
		try {
			parseSessionStrict(JSON.parse(text), known);
			setLegacy(null);
		} catch (err) {
			setLegacy({
				message:
					"Attention : cet audit contient des textes, des adresses ou des indices plus longs ou plus nombreux que ce que Rampe accepte aujourd’hui (saisis avec une version précédente). Le fichier est complet, mais son import sera refusé ou ses textes tronqués : raccourcissez-les ici, puis téléchargez à nouveau.",
				detail: err instanceof ReportError ? err.detail : (err as Error).message,
			});
		}
		setAnnounce(`Audit téléchargé : ${name}`);
		return name;
	};
	const replace = (before: AuditSession, next: AuditSession) => {
		const summary = {
			pages: next.pages.length,
			evaluations: Object.values(next.evaluations).reduce((n, byPage) => n + Object.keys(byPage).length, 0),
			findings: Object.values(next.findings).reduce(
				(n, byPage) => n + Object.values(byPage).reduce((m, list) => m + list.length, 0),
				0,
			),
		};
		const message = `Audit importé : ${plural(summary.pages, "page")}, ${plural(summary.evaluations, "évaluation")} enregistrée${summary.evaluations > 1 ? "s" : ""}, ${plural(summary.findings, "indice")}. L’audit précédent a été remplacé.`;
		imp.apply(before, next, summary, message);
	};
	const onChange = (e: Event) =>
		imp.read(
			e,
			"Ce fichier n’est pas un fichier JSON lisible : choisissez un fichier audit-….json téléchargé depuis Rampe. Rien n’a été importé.",
			(json, current) => {
				let next: AuditSession;
				try {
					next = parseSessionStrict(json, known);
				} catch (err) {
					if (err instanceof ReportError) return imp.refuse(err.message, err.detail);
					return imp.refuse(INVALID_SESSION, (err as Error).message);
				}
				if (current.pages.length === 0) return replace(current, next);
				setDownloaded("");
				setPending(next);
			},
		);
	const confirmReplace = () => {
		const next = pending;
		dialogRef.current?.close();
		if (next) replace(latest.current, next);
	};
	const changedSince =
		session.exportedAt !== undefined && Date.parse(session.updatedAt) > Date.parse(session.exportedAt);

	return (
		<section aria-labelledby="audit-sauvegarde" class="audit-backup">
			<h2 id="audit-sauvegarde">Sauvegarde de l’audit</h2>
			<p>
				Cet audit n’existe que dans ce navigateur. Dernier téléchargement :{" "}
				{session.exportedAt ? dateTime(session.exportedAt) : "jamais"}
				{changedSince && " (l’audit a changé depuis)"}.
			</p>
			<button type="button" onClick={download}>
				Télécharger l’audit (JSON)
			</button>
			{legacy && <ImportError id="audit-telechargement-alerte" error={legacy} />}
			<div class="audit-session-import">
				<h3>Audit Rampe complet : reprendre un audit téléchargé</h3>
				<p id="audit-session-aide">
					Fichier <code>audit-….json</code> téléchargé avec le bouton ci-dessus, dans ce navigateur ou un autre (64 Mo
					au plus). Il remplace l’audit en cours. Pour les résultats de l’audit automatique, utilisez plutôt « Rapport
					de la CLI », section « 1. Pages de l’échantillon ».
				</p>
				<label for="audit-session">Importer un audit (JSON)</label>
				<input
					id="audit-session"
					ref={inputRef}
					type="file"
					accept="application/json,.json"
					onChange={onChange}
					aria-invalid={error ? "true" : undefined}
					aria-describedby={error ? "audit-session-aide audit-session-erreur" : "audit-session-aide"}
				/>
				{error && <ImportError id="audit-session-erreur" error={error} />}
				{undone && <p>{UNDONE}</p>}
				{done && (
					<div class="audit-session-summary">
						<p>
							Audit importé : {plural(done.summary.pages, "page")}, {plural(done.summary.evaluations, "évaluation")}{" "}
							enregistrée{done.summary.evaluations > 1 ? "s" : ""}, {plural(done.summary.findings, "indice")}. L’audit
							précédent a été remplacé.
						</p>
						{imp.canUndo && (
							<button type="button" onClick={imp.undo}>
								Annuler cet import
							</button>
						)}
					</div>
				)}
			</div>
			{/* Boîte native et modale : focus piégé par le navigateur, Échap ferme ; le focus revient au champ fichier. */}
			<dialog
				ref={dialogRef}
				class="audit-dialog"
				aria-labelledby="audit-remplacer-titre"
				aria-describedby="audit-remplacer-texte"
				onClose={(e) => {
					setPending(null);
					// L'événement `close` arrive après coup (tâche du navigateur) : on ne rend le focus au champ que s'il est
					// resté dans la boîte ou perdu, jamais s'il est déjà ailleurs (« Annuler cet import », par exemple).
					const active = document.activeElement;
					if (!active || active === document.body || (e.currentTarget as HTMLElement).contains(active))
						inputRef.current?.focus();
				}}
			>
				{pending && (
					<>
						<h2 id="audit-remplacer-titre">Remplacer l’audit en cours ?</h2>
						<p id="audit-remplacer-texte">
							L’audit en cours ({plural(session.pages.length, "page")}, {session.site}) sera remplacé par celui du
							fichier ({plural(pending.pages.length, "page")}
							{pending.site && `, ${pending.site}`}). Téléchargez d’abord l’audit en cours si vous voulez pouvoir y
							revenir.
						</p>
						<p role="status">{downloaded && `Audit en cours téléchargé : ${downloaded}`}</p>
						<div class="audit-dialog-actions">
							<button type="button" onClick={() => setDownloaded(download())}>
								Télécharger d’abord l’audit en cours
							</button>
							<button type="button" class="audit-replace" onClick={confirmReplace}>
								Remplacer l’audit en cours
							</button>
							<button type="button" onClick={() => dialogRef.current?.close()}>
								Annuler
							</button>
						</div>
					</>
				)}
			</dialog>
		</section>
	);
}

const summaryText = (s: ImportSummary) =>
	`Import terminé : ${plural(s.pagesAdded, "page")} ajoutée${s.pagesAdded > 1 ? "s" : ""}, ${plural(s.statusesSet, "statut")} « Non conforme » à confirmer, ${plural(s.findingsAdded, "indice")}${s.pagesSkipped.length > 0 ? `, ${plural(s.pagesSkipped.length, "page")} en erreur non importée${s.pagesSkipped.length > 1 ? "s" : ""}` : ""}. Vos évaluations déjà saisies n’ont pas été modifiées.`;

/** Méthode officielle, sections « Test des pages » et « Taux de conformité à la norme ». */
const METHOD_URL = "https://accessibilite.numerique.gouv.fr/obligations/evaluation-conformite/";

/**
 * Résultat (ADR-0015) : le seul endroit de l'interface où un pourcentage apparaît, et seulement quand l'audit est
 * complet. Sinon, ce qui manque et un raccourci vers les critères concernés.
 */
function Result({
	session,
	criteria,
	r,
	showMissing,
}: {
	session: AuditSession;
	criteria: AuditCriterion[];
	r: Conformity;
	showMissing: (f: "NT" | "auto") => void;
}) {
	const rate = (value: number | null) => (value === null ? "sans objet (aucun critère applicable)" : formatRate(value));
	let body: ComponentChildren;
	if (session.pages.length === 0)
		body = <p>Ajoutez au moins une page à l’échantillon : le résultat s’affichera ici.</p>;
	else if (!r.complete)
		body = (
			<>
				<p>
					<strong>
						Audit incomplet : {plural(r.remaining, "évaluation")} restante{r.remaining > 1 ? "s" : ""},{" "}
						{plural(r.toConfirm, "statut")} à confirmer.
					</strong>{" "}
					Le taux de conformité n’est calculé que lorsque chaque critère a un statut confirmé sur chaque page.
				</p>
				<p class="audit-result-actions">
					{r.remaining > 0 && (
						<button type="button" onClick={() => showMissing("NT")}>
							Afficher les critères non testés
						</button>
					)}
					{r.toConfirm > 0 && (
						<button type="button" onClick={() => showMissing("auto")}>
							Afficher les statuts à confirmer
						</button>
					)}
				</p>
			</>
		);
	else {
		// Un libellé par processus, le premier saisi : les variantes regroupées (« commande », « Commande ») se voient.
		const processLabels = new Map<string, string>();
		for (const p of session.pages) {
			const key = processKey(p.process);
			if (key !== null && !processLabels.has(key))
				processLabels.set(key, (p.process ?? "").replace(/\s+/g, " ").trim());
		}
		const failed = criteria.filter((c) => r.criteria.some((x) => x.criterion === c.id && x.status === "non validé"));
		body = (
			<>
				<dl class="audit-rates">
					<dt>Pourcentage de critères respectés (taux global)</dt>
					<dd>
						<strong class="audit-rate">{rate(r.globalRate)}</strong>
						<p>
							« Le pourcentage de critères RGAA respectés s’obtient en divisant le nombre de critères validés par le
							nombre de critères applicables. » Ici : {plural(r.validated, "critère")} validé
							{r.validated > 1 ? "s" : ""} sur {r.applicable} applicable{r.applicable > 1 ? "s" : ""}.
						</p>
					</dd>
					<dt>Taux moyen de conformité</dt>
					<dd>
						<strong class="audit-rate">{rate(r.averageRate)}</strong>
						<p>
							« Le taux moyen de conformité du service en ligne s’obtient en faisant la moyenne des taux de conformité
							de chaque page. » Une page sans critère applicable n’a pas de taux et n’entre pas dans la moyenne.
						</p>
					</dd>
				</dl>
				<p>
					Source : <a href={METHOD_URL}>méthode officielle d’évaluation de la conformité</a> (RGAA, sections « Test des
					pages » et « Taux de conformité à la norme »). {plural(r.notApplicable, "critère")} non applicable
					{r.notApplicable > 1 ? "s" : ""} sur toutes les pages n’entre{r.notApplicable > 1 ? "nt" : ""} pas dans le
					calcul.
				</p>
				<p>
					<strong>Ce taux mesure la conformité de votre échantillon ; il n’est pas une certification.</strong>
				</p>
				{/* Défilement horizontal au clavier sur petit écran : la région est nommée par la légende et focalisable. */}
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: une zone qui défile doit être atteignable au clavier (règle axe scrollable-region-focusable, WCAG 2.1.1). */}
				<section class="audit-table" aria-labelledby="audit-resultat-pages" tabIndex={0}>
					<table>
						<caption id="audit-resultat-pages">Résultat par page</caption>
						<thead>
							<tr>
								<th scope="col">Page</th>
								<th scope="col">Processus</th>
								<th scope="col">Critères validés</th>
								<th scope="col">Non validés</th>
								<th scope="col">Non applicables</th>
								<th scope="col">Taux de conformité</th>
							</tr>
						</thead>
						<tbody>
							{r.pages.map((pr) => {
								const p = session.pages.find((x) => x.id === pr.pageId) as SessionPage;
								return (
									<tr key={pr.pageId}>
										<th scope="row">{pageName(p)}</th>
										<td>{processLabels.get(processKey(p.process) ?? "") ?? "aucun"}</td>
										<td>{pr.validated}</td>
										<td>{pr.invalidated}</td>
										<td>{pr.notApplicable}</td>
										<td>{rate(pr.rate)}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</section>
				<h3>Critères non validés ({failed.length})</h3>
				{failed.length > 0 ? (
					<ul class="audit-failed">
						{failed.map((c) => (
							<li key={c.id}>
								<a href={c.href}>
									Critère {c.id} : <span {...trustedBuildHtml(c.titleTextHtml)} />
								</a>
							</li>
						))}
					</ul>
				) : (
					<p>Aucun : tous les critères applicables sont validés sur toutes les pages.</p>
				)}
			</>
		);
	}
	return (
		<section aria-labelledby="audit-resultat" class="audit-result">
			<h2 id="audit-resultat">3. Résultat</h2>
			{body}
		</section>
	);
}

/** Champ de la déclaration : étiquette, aide courte, et nature (une ligne, une par ligne, adresse, date). */
type DeclarationInput = { field: DeclarationField; label: string; help?: string; kind?: "lines" | "url" | "date" };
const DECLARATION_GROUPS: { legend: string; fields: DeclarationInput[] }[] = [
	{
		legend: "Organisme et site",
		fields: [
			{ field: "organization", label: "Nom de l’organisme", help: "Tel qu’il figure dans vos mentions légales." },
			{
				field: "commitment",
				label: "Ce que l’organisme s’engage à rendre accessible",
				help: "Par exemple « son site internet » ou « ses sites internet et son application mobile ».",
			},
			{ field: "serviceName", label: "Nom du site", help: "Par exemple « exemple.fr » ou « Site de la boutique »." },
			{
				field: "schemeUrl",
				label: "Adresse du schéma pluriannuel de mise en accessibilité",
				help: "Document qui planifie la mise en accessibilité sur plusieurs années : rédigez-le avec la section 5, publiez-le sur votre site, puis indiquez son adresse ici.",
				kind: "url",
			},
			{
				field: "actionPlanUrl",
				label: "Adresse du plan d’action de l’année en cours",
				help: "Avec le bilan des actions de l’année précédente (section 5), publié sur votre site.",
				kind: "url",
			},
		],
	},
	{
		legend: "Audit",
		fields: [
			{
				field: "reportUrl",
				label: "Adresse du rapport ou de la grille d’audit (facultatif)",
				help: "Sinon, le détail des tests reste à compléter.",
				kind: "url",
			},
			{
				field: "testEnvironment",
				label: "Environnement de test, une combinaison par ligne",
				help: "Navigateur et technologie d’assistance, par exemple « Firefox et NVDA ».",
				kind: "lines",
			},
			{
				field: "tools",
				label: "Outils utilisés, un par ligne",
				help: "Par exemple « Rampe » ou « Colour Contrast Analyser ».",
				kind: "lines",
			},
			{
				field: "technologies",
				label: "Technologies du site, une par ligne",
				help: "Par exemple « HTML », « CSS », « JavaScript ».",
				kind: "lines",
			},
		],
	},
	{
		legend: "Contenus non accessibles",
		fields: [
			{
				field: "nonConformities",
				label: "Précisions sur les non-conformités, une par ligne",
				help: "Rampe liste déjà les critères non conformes de l’audit. Ajoutez les contenus concernés et les alternatives proposées.",
				kind: "lines",
			},
			{
				field: "derogations",
				label: "Dérogations pour charge disproportionnée, une par ligne",
				help: "Chaque dérogation doit être expliquée et motivée, avec l’alternative proposée.",
				kind: "lines",
			},
			{
				field: "exemptions",
				label: "Contenus non soumis à l’obligation, un par ligne",
				help: "Contenus exemptés par le champ d’application officiel.",
				kind: "lines",
			},
		],
	},
	{
		legend: "Dates",
		fields: [
			{
				field: "establishedOn",
				label: "Date d’établissement (facultatif)",
				help: "Fixée au premier téléchargement ou à la première copie ; modifiable.",
				kind: "date",
			},
			{ field: "updatedOn", label: "Date de mise à jour (facultatif)", kind: "date" },
		],
	},
	{
		legend: "Contact",
		fields: [
			{
				field: "contactFormUrl",
				label: "Formulaire de contact ou adresse e-mail",
				help: "Pour signaler un défaut d’accessibilité, par exemple https://exemple.fr/contact ou accessibilite@exemple.fr.",
				kind: "url",
			},
			{ field: "contactEntity", label: "Service à contacter", help: "Par exemple « Service client »." },
			{ field: "contactPageUrl", label: "Page web de ses coordonnées", kind: "url" },
		],
	},
];
const LIMITS = { lines: MAX_NOTE, url: MAX_URL, text: MAX_TITLE } as const;

/** Aperçu rendu par Preact depuis le modèle : chaque saisie est du texte, échappé par Preact (jamais d'innerHTML). */
function Inlines({ content }: { content: Inline[] }) {
	return (
		<>
			{content.map((i, k) => {
				if (i.kind === "text" || i.kind === "input") return i.text;
				if (i.kind === "slot") return <mark key={k}>[{i.text}]</mark>;
				if (i.kind === "link")
					return (
						<a key={k} href={i.href}>
							<Inlines content={i.label} />
						</a>
					);
				return <br key={k} />;
			})}
		</>
	);
}
function Preview({ blocks }: { blocks: Block[] }) {
	return (
		<>
			{blocks.map((b, k) => {
				if (b.kind === "list")
					return (
						<ul key={k}>
							{b.items.map((item, j) => (
								<li key={j}>
									<Inlines content={item} />
								</li>
							))}
						</ul>
					);
				if (b.kind === "paragraph")
					return (
						<p key={k}>
							<Inlines content={b.content} />
						</p>
					);
				// Le titre de la déclaration est celui de l'aperçu ; les autres descendent sous lui (h4, h5).
				if (b.level === 1) return null;
				const H = b.level === 2 ? "h4" : "h5";
				return (
					<H key={k}>
						<Inlines content={b.content} />
					</H>
				);
			})}
		</>
	);
}

/**
 * Déclaration d'accessibilité (ADR-0017) : Rampe remplit ce qu'il calcule depuis l'audit, l'utilisateur le reste.
 * Saisies rangées dans la session (sauvegardées et exportées avec elle), exports fabriqués dans le navigateur.
 */
function Declaration({
	session,
	setSession,
	setAnnounce,
	criteria,
	r,
	rgaaVersion,
}: {
	session: AuditSession;
	setSession: (update: (s: AuditSession) => AuditSession) => void;
	setAnnounce: (message: string) => void;
	criteria: AuditCriterion[];
	r: Conformity;
	rgaaVersion: string;
}) {
	const [touched, setTouched] = useState<ReadonlySet<DeclarationField>>(new Set());
	/** Date en cours de saisie hors limites (« 0010-10-14 ») : affichée, jamais enregistrée ni publiée. */
	const [drafts, setDrafts] = useState<Partial<Record<DeclarationField, string>>>({});
	const fields = session.declaration ?? {};
	const titles = useMemo(() => Object.fromEntries(criteria.map((c) => [c.id, c.titleText])), [criteria]);
	const options = { date: new Date(), rgaaVersion, criterionTitles: titles };
	const blocks = declarationBlocks(session, r, fields, options);
	const state = conformityState(r);
	const set = (field: DeclarationField, value: string) => setSession((s) => setDeclarationField(s, field, value));
	/**
	 * Date : la saisie reste un brouillon jusqu'à la sortie du champ (le navigateur émet chaque état intermédiaire,
	 * « 0002-10-14 », « 2757-10-14 »…), puis n'est enregistrée que vide ou valide (1900 à 9999) ; sinon, message.
	 */
	const commitDate = (field: DeclarationField) => {
		const value = drafts[field];
		if (value === undefined || (value !== "" && !isDay(value))) return;
		setDrafts(({ [field]: _old, ...rest }) => rest);
		set(field, value);
	};
	/** Date d'établissement figée au premier export : une déclaration ne change pas de date à chaque téléchargement. */
	/**
	 * Avant tout export : les dates en brouillon sont validées et enregistrées (même règle qu'à la sortie du champ),
	 * et la date d'établissement est figée si elle ne l'est pas (première copie ou premier téléchargement). Le document
	 * est produit à partir de cet état à jour, jamais d'un état antérieur au clic. Un brouillon invalide bloque
	 * l'export : message relié au champ, focus dessus. `null` : export bloqué.
	 */
	const prepare = (): AuditSession | null => {
		const updates: [DeclarationField, string][] = [];
		for (const [field, value] of Object.entries(drafts) as [DeclarationField, string][]) {
			if (value !== "" && !isDay(value)) {
				setTouched((t) => new Set(t).add(field));
				document.getElementById(`declaration-${field}`)?.focus();
				setAnnounce("Export impossible : une date est incomplète ou hors limites (années 1900 à 9999).");
				return null;
			}
			updates.push([field, value]);
		}
		const apply = (s: AuditSession) => {
			let next = updates.reduce((acc, [field, value]) => setDeclarationField(acc, field, value), s);
			if (!next.declaration?.establishedOn) {
				const d = new Date();
				const pad = (n: number) => String(n).padStart(2, "0");
				next = setDeclarationField(
					next,
					"establishedOn",
					`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
				);
			}
			return next;
		};
		setDrafts({});
		setSession(apply);
		return apply(session);
	};
	const render = (current: AuditSession, format: "html" | "markdown", standalone = false) =>
		renderDeclaration(current, r, current.declaration ?? {}, { ...options, format, standalone });
	const download = (format: "html" | "markdown") => {
		const current = prepare();
		if (!current) return;
		const ext = format === "html" ? "html" : "md";
		const name = declarationFileName(current, new Date(), ext);
		saveFile(name, render(current, format, true), format === "html" ? "text/html" : "text/markdown");
		setAnnounce(`Déclaration téléchargée : ${name}`);
	};
	const copy = async () => {
		const current = prepare();
		if (!current) return;
		try {
			await navigator.clipboard.writeText(render(current, "html"));
			setAnnounce("Code HTML de la déclaration copié dans le presse-papiers.");
		} catch {
			setAnnounce("Copie impossible dans ce navigateur : utilisez « Télécharger (HTML) ».");
		}
	};

	const rate = r.complete && r.globalRate !== null ? formatRate(r.globalRate) : null;
	let status: ComponentChildren;
	if (state.state !== "non")
		status = (
			<p>
				<strong>{state.state === "totalement" ? "Totalement conforme" : "Partiellement conforme"}</strong> : {rate} des
				critères RGAA respectés (règle officielle : tous les critères pour « totalement », au moins 50 % pour «
				partiellement »).
			</p>
		);
	else if (state.reason !== "incomplete")
		status = (
			<p>
				<strong>Non conforme</strong> : {NON_CONFORMITY_REASONS[state.reason]}
				{rate && ` Pourcentage de critères respectés : ${rate}.`}
			</p>
		);
	else
		status = (
			<p>
				<strong>Non conforme : aucun résultat d’audit complet.</strong> La règle officielle classe « non conforme » tout
				service sans résultat d’audit permettant de mesurer le respect des critères. Pour une déclaration « totalement »
				ou « partiellement » conforme,{" "}
				{session.pages.length === 0 ? (
					<>
						ajoutez des pages à l’échantillon (<a href="#audit-echantillon">section 1</a>), puis évaluez chaque critère.
					</>
				) : (
					<>
						terminez l’audit : {plural(!r.complete ? r.remaining : 0, "évaluation")} « non testé » et{" "}
						{plural(!r.complete ? r.toConfirm : 0, "statut")} à confirmer.{" "}
						<a href="#audit-resultat">Voir ce qui reste à faire (section 3)</a>.
					</>
				)}
			</p>
		);

	const input = ({ field, label, help, kind }: DeclarationInput) => {
		const id = `declaration-${field}`;
		const value = drafts[field] ?? fields[field] ?? "";
		const draft = drafts[field];
		const invalid =
			touched.has(field) &&
			(kind === "url"
				? value.trim() !== "" && safeUrl(value) === null
				: draft !== undefined && draft !== "" && !isDay(draft));
		const describedBy = [help && `${id}-aide`, invalid && `${id}-erreur`].filter(Boolean).join(" ") || undefined;
		const common = {
			id,
			value,
			"aria-describedby": describedBy,
			"aria-invalid": invalid ? ("true" as const) : undefined,
			onInput: (e: Event) => {
				const v = (e.currentTarget as HTMLInputElement).value;
				if (kind === "date") setDrafts((d) => ({ ...d, [field]: v }));
				else set(field, v);
			},
			onBlur: () => {
				if (kind === "date") commitDate(field);
				setTouched((t) => new Set(t).add(field));
			},
		};
		return (
			<div class="audit-field" key={field}>
				<label for={id}>{label}</label>
				{help && (
					<p id={`${id}-aide`} class="audit-help">
						{help}
					</p>
				)}
				{kind === "lines" ? (
					<textarea {...common} rows={3} maxLength={Math.max(LIMITS.lines, value.length)} />
				) : kind === "date" ? (
					<input {...common} type="date" min="1900-01-01" max="9999-12-31" />
				) : (
					<input
						{...common}
						type="text"
						inputMode={kind === "url" ? "url" : undefined}
						maxLength={Math.max(kind === "url" ? LIMITS.url : LIMITS.text, value.length)}
					/>
				)}
				{invalid && kind === "date" && (
					<p id={`${id}-erreur`} class="audit-error">
						Date incomplète ou hors limites (années 1900 à 9999) : elle n’est pas enregistrée.
					</p>
				)}
				{invalid && kind === "url" && (
					<p id={`${id}-erreur`} class="audit-error">
						Adresse non reconnue : commencez par https:// ou saisissez une adresse e-mail. En attendant, elle reste « à
						compléter » dans la déclaration.
					</p>
				)}
			</div>
		);
	};
	const auditBy = fields.auditBy ?? "";

	return (
		<section aria-labelledby="audit-declaration" class="audit-declaration">
			<h2 id="audit-declaration">4. Déclaration d’accessibilité</h2>
			<p>
				La déclaration reprend le résultat de votre audit dans le{" "}
				<a href={DECLARATION_URL}>format imposé par la réglementation</a>. Rampe remplit ce qu’il calcule (état de
				conformité, pourcentage de critères respectés, taux moyen, critères non conformes, pages vérifiées, date
				d’établissement, et le motif d’un état « non conforme » sans mesure) ; vous complétez le reste ci-dessous. Ce
				qui manque reste affiché [entre crochets]. Votre organisme est-il soumis à l’obligation ? Consultez le{" "}
				<a href={SCOPE_URL}>champ d’application officiel</a>.
			</p>
			<p class="audit-help">
				Choix imposés par Rampe, qui audite un site web : « site internet », « du site web », et le référentiel « RGAA,
				version {rgaaVersion} » de votre audit.
			</p>
			<div class="audit-reminder">
				<p>
					<strong>Cette déclaration engage votre organisme ; Rampe la met seulement en forme.</strong>
				</p>
				<p>
					Validité : à mettre à jour lors d’une modification substantielle ou d’une refonte du site, 3 ans après sa
					publication, ou 18 mois après la publication d’une nouvelle version du RGAA.
				</p>
			</div>

			<h3>État de conformité</h3>
			<div class="audit-state">{status}</div>

			<h3>À compléter</h3>
			<p class="audit-help">
				Enregistré avec l’audit, dans ce navigateur, et inclus dans « Télécharger l’audit (JSON) ».
			</p>
			{DECLARATION_GROUPS.map((g) => (
				<fieldset class="audit-declaration-group" key={g.legend}>
					<legend>{g.legend}</legend>
					{g.legend === "Audit" && (
						<fieldset class="audit-auditby">
							<legend>L’audit a été réalisé</legend>
							{(
								[
									["interne", "En interne"],
									["prestataire", "Par un prestataire"],
								] as const
							).map(([value, label]) => (
								<label key={value}>
									<input
										type="radio"
										name="declaration-auditBy"
										value={value}
										checked={auditBy === value}
										onChange={() => set("auditBy", value)}
									/>{" "}
									{label}
								</label>
							))}
						</fieldset>
					)}
					{g.legend === "Audit" &&
						auditBy === "prestataire" &&
						input({ field: "auditCompany", label: "Nom du prestataire" })}
					{g.fields.map(input)}
				</fieldset>
			))}

			<section aria-labelledby="audit-apercu" class="audit-preview">
				<h3 id="audit-apercu">Aperçu de la déclaration</h3>
				<Preview blocks={blocks} />
			</section>
			<p class="audit-declaration-actions">
				<button type="button" onClick={copy}>
					Copier le HTML
				</button>
				<button type="button" onClick={() => download("html")}>
					Télécharger (HTML)
				</button>
				<button type="button" onClick={() => download("markdown")}>
					Télécharger (Markdown)
				</button>
			</p>
		</section>
	);
}

const YEAR_ERROR =
	"Année incomplète ou hors limites (1900 à 9999, période terminée au plus tard en 9999) : elle n’est pas enregistrée.";

/**
 * Schéma pluriannuel et plan d'action (ADR-0018) : un guide de rédaction qui suit la liste officielle, et un tableau
 * d'actions pré-rempli depuis l'audit. Rampe n'écrit aucun texte de politique ; tout est rangé dans la session.
 */
function Schema({
	session,
	setSession,
	setAnnounce,
	criteria,
	r,
}: {
	session: AuditSession;
	setSession: (update: (s: AuditSession) => AuditSession) => void;
	setAnnounce: (message: string) => void;
	criteria: AuditCriterion[];
	r: Conformity;
}) {
	const p = session.schema;
	const years = periodYears(p);
	/** Année de début en cours de saisie : enregistrée à la sortie du champ, ou avant un export, si elle est valide. */
	const [startDraft, setStartDraft] = useState<string | undefined>(undefined);
	const [startInvalid, setStartInvalid] = useState(false);
	const [newTitle, setNewTitle] = useState("");
	const [newInvalid, setNewInvalid] = useState(false);
	const [chosenYear, setChosenYear] = useState<number | null>(null);
	const thisYear = new Date().getFullYear();
	const year =
		chosenYear !== null && years.includes(chosenYear) ? chosenYear : years.includes(thisYear) ? thisYear : years[0];
	const titles = useMemo(() => Object.fromEntries(criteria.map((c) => [c.id, c.titleText])), [criteria]);
	const actions = p?.actions ?? [];

	/** Opération vérifiée sur l'état courant (un refus est annoncé, rien n'est écrit), puis appliquée. */
	const apply = (op: (s: AuditSession) => AuditSession, refused?: string) => {
		try {
			op(session);
		} catch (e) {
			setAnnounce(refused ?? (e as Error).message);
			return false;
		}
		setSession(op);
		return true;
	};
	/** `null` : année refusée ; `undefined` : champ vide. */
	const parseStart = (value: string) => {
		const v = value.trim();
		if (v === "") return undefined;
		const n = Number(v);
		return /^\d{4}$/.test(v) && n >= 1900 && n + (p?.duration ?? 1) - 1 <= 9999 ? n : null;
	};
	const commitStart = (): AuditSession | null => {
		if (startDraft === undefined) return session;
		const n = parseStart(startDraft);
		if (n === null) {
			setStartInvalid(true);
			return null;
		}
		const op = (s: AuditSession) => setSchemaPeriod(s, n, s.schema?.duration);
		setStartDraft(undefined);
		setStartInvalid(false);
		setSession(op);
		return op(session);
	};
	const sync = () => {
		if (!r.complete) {
			setAnnounce("Audit incomplet : aucune action n’est proposée tant que l’audit n’est pas terminé.");
			return;
		}
		const result = proposeActions(session, r, titles);
		if (result.session !== session) setSession(() => result.session);
		setAnnounce(
			result.added + result.updated === 0
				? "Tableau déjà à jour : aucune action ajoutée ni modifiée."
				: `${plural(result.added, "action")} ajoutée${result.added > 1 ? "s" : ""}, ${plural(result.updated, "action")} mise${result.updated > 1 ? "s" : ""} à jour.`,
		);
	};
	const addAction = (e: Event) => {
		e.preventDefault();
		if (!newTitle.trim()) {
			setNewInvalid(true);
			document.getElementById("schema-nouvelle-action")?.focus();
			return;
		}
		if (apply((s) => addFreeAction(s, newTitle))) {
			setAnnounce(`Action ajoutée : ${newTitle.trim()}`);
			setNewTitle("");
			setNewInvalid(false);
		}
	};
	const update = (a: SchemaAction, patch: ActionPatch) => apply((s) => updateAction(s, a.id, patch));
	/** Liste de choix d'une ligne du tableau, étiquetée par l'action ; la première option est « vide ». */
	const choice = (
		label: string,
		value: string | number | undefined,
		empty: string,
		options: readonly (string | number)[],
		set: (value: string) => void,
	) => (
		<td>
			<select
				aria-label={label}
				value={value ?? ""}
				onChange={(e) => set((e.currentTarget as HTMLSelectElement).value)}
			>
				<option value="">{empty}</option>
				{options.map((v) => (
					<option key={v} value={v}>
						{v}
					</option>
				))}
			</select>
		</td>
	);
	const name = (a: SchemaAction) => (a.source === "audit" ? `Critère ${a.criterion} : ${a.title}` : a.title);
	const download = (doc: "schema" | "plan", format: "html" | "markdown") => {
		const current = commitStart();
		if (!current) {
			document.getElementById("schema-debut")?.focus();
			setAnnounce("Export impossible : l’année de début est incomplète ou hors limites.");
			return;
		}
		const ext = format === "html" ? "html" : "md";
		const options = { format, standalone: true } as const;
		const planYear = periodYears(current.schema).includes(year as number) ? year : periodYears(current.schema)[0];
		if (doc === "plan" && planYear === undefined) return;
		const [file, content] =
			doc === "schema"
				? [schemaFileName(current, new Date(), ext), renderSchema(current, r, options)]
				: [
						planFileName(current, planYear as number, new Date(), ext),
						renderAnnualPlan(planYear as number, current, r, options),
					];
		saveFile(file, content, format === "html" ? "text/html" : "text/markdown");
		setAnnounce(`${doc === "schema" ? "Schéma pluriannuel" : "Plan d’action"} téléchargé : ${file}`);
	};

	const startValue = startDraft ?? (p?.startYear !== undefined ? String(p.startYear) : "");
	const voletField = (id: (typeof VOLETS)[number]["id"], label: string, description: string) => {
		const value = p?.sections[id] ?? "";
		return (
			<div class="audit-field" key={id}>
				<label for={`schema-${id}`}>{label}</label>
				<p id={`schema-${id}-aide`} class="audit-help">
					Consigne officielle : le schéma présente {description}.
				</p>
				<textarea
					id={`schema-${id}`}
					aria-describedby={`schema-${id}-aide`}
					rows={3}
					value={value}
					maxLength={Math.max(MAX_SECTION, value.length)}
					onInput={(e) => apply((s) => setSchemaSection(s, id, (e.currentTarget as HTMLTextAreaElement).value))}
				/>
			</div>
		);
	};

	return (
		<section aria-labelledby="audit-schema" class="audit-schema">
			<h2 id="audit-schema">5. Schéma pluriannuel et plan d’action</h2>
			<p>
				Le <a href={SCHEMA_URL}>schéma pluriannuel</a> présente, pour trois ans au plus, la politique d’accessibilité de
				votre organisme et ses travaux de mise en conformité, planifiés chaque année dans un plan d’action. Rampe suit
				la liste officielle des volets et pré-remplit seulement le tableau des mesures correctives depuis votre audit.
				Publiez le schéma et le plan de l’année en cours sur votre site, puis indiquez leurs adresses dans la
				déclaration (section 4).
			</p>
			<div class="audit-reminder">
				<p>
					<strong>{SCHEMA_MENTION}</strong>
				</p>
			</div>

			<fieldset class="audit-declaration-group">
				<legend>Période du schéma</legend>
				<div class="audit-field">
					<label for="schema-debut">Année de début</label>
					<input
						id="schema-debut"
						type="text"
						inputMode="numeric"
						autoComplete="off"
						maxLength={4}
						value={startValue}
						aria-invalid={startInvalid ? "true" : undefined}
						aria-describedby={startInvalid ? "schema-debut-erreur" : undefined}
						onInput={(e) => setStartDraft((e.currentTarget as HTMLInputElement).value)}
						onBlur={commitStart}
					/>
					{startInvalid && (
						<p id="schema-debut-erreur" class="audit-error">
							{YEAR_ERROR}
						</p>
					)}
				</div>
				<div class="audit-field">
					<label for="schema-duree">Durée</label>
					<select
						id="schema-duree"
						value={p?.duration ?? ""}
						onChange={(e) => {
							const v = (e.currentTarget as HTMLSelectElement).value;
							apply(
								(s) => setSchemaPeriod(s, s.schema?.startYear, v ? Number(v) : undefined),
								"Durée refusée : la période se terminerait après 9999.",
							);
						}}
					>
						<option value="">à choisir</option>
						<option value="1">1 an</option>
						<option value="2">2 ans</option>
						<option value="3">3 ans (au plus)</option>
					</select>
				</div>
			</fieldset>

			<h3>Volets du schéma</h3>
			<p class="audit-help">
				Un champ par volet de la liste officielle, dans son ordre. Un volet vide reste « à compléter » dans le document.
			</p>
			{(["politique", "travaux"] as const).map((part) => (
				<fieldset class="audit-declaration-group" key={part}>
					<legend>
						{part === "politique" ? "Politique d’accessibilité numérique" : "Travaux de mise en conformité"}
					</legend>
					{VOLETS.filter((v) => v.part === part).map((v) => voletField(v.id, v.label, v.description))}
				</fieldset>
			))}

			<h3>Mesures correctives : tableau d’actions</h3>
			<p class="audit-help">
				Chaque critère non validé de l’audit devient une action proposée. Fixez sa priorité (consigne officielle :
				traiter d’abord les contenus les plus consultés et les services les plus utilisés) et son année cible dans la
				période. Retirer une action la garde visible, pour qu’aucune non-conformité ne disparaisse en silence.
			</p>
			<p class="audit-result-actions">
				<button type="button" onClick={sync}>
					Mettre à jour depuis l’audit
				</button>
			</p>
			{!r.complete && (
				<p>
					Audit incomplet : aucune action n’est proposée tant que l’audit n’est pas terminé.{" "}
					<a href="#audit-resultat">Terminer l’audit (section 3)</a>.
				</p>
			)}
			{years.length === 0 && actions.length > 0 && (
				<p class="audit-help">Choisissez d’abord la période : les années cibles en dépendent.</p>
			)}
			{actions.length > 0 && (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: une zone qui défile doit être atteignable au clavier (règle axe scrollable-region-focusable, WCAG 2.1.1).
				<section class="audit-table audit-schema-table" aria-labelledby="schema-actions-titre" tabIndex={0}>
					<table>
						<caption id="schema-actions-titre">Actions de mise en conformité ({actions.length})</caption>
						<thead>
							<tr>
								<th scope="col">Action</th>
								<th scope="col">Priorité</th>
								<th scope="col">Année cible</th>
								<th scope="col">Commentaire</th>
								<th scope="col">Bilan</th>
								<th scope="col">Retrait</th>
							</tr>
						</thead>
						<tbody>
							{actions.map((a) => {
								const n = name(a);
								const state = actionState(a, r);
								const pages = (a.pages ?? []).flatMap((id) => {
									const page = session.pages.find((x) => x.id === id);
									return page ? [pageName(page)] : [];
								});
								const outside = a.targetYear !== undefined && !years.includes(a.targetYear);
								return (
									<tr key={a.id} class={a.removed ? "audit-removed" : undefined}>
										<th scope="row">
											{n}
											{pages.length > 0 && <span class="audit-help"> ({pages.join(", ")})</span>}
											{state && <strong> Critère désormais {state}.</strong>}
											{outside && <strong> Année cible hors période.</strong>}
											{a.removed && <strong> Retirée.</strong>}
										</th>
										{choice(`Priorité de l’action : ${n}`, a.priority, "à définir", PRIORITIES, (v) =>
											update(a, { priority: (v || undefined) as ActionPatch["priority"] }),
										)}
										{choice(
											`Année cible de l’action : ${n}`,
											a.targetYear,
											"à définir",
											outside ? [a.targetYear as number, ...years] : years,
											(v) => update(a, { targetYear: v ? Number(v) : undefined }),
										)}
										<td>
											<input
												type="text"
												aria-label={`Commentaire de l’action : ${n}`}
												value={a.comment}
												maxLength={Math.max(MAX_NOTE, a.comment.length)}
												onInput={(e) => update(a, { comment: (e.currentTarget as HTMLInputElement).value })}
											/>
										</td>
										{choice(`Bilan de l’action : ${n}`, a.status, "à renseigner", ACTION_STATUSES, (v) =>
											update(a, { status: (v || undefined) as ActionPatch["status"] }),
										)}
										<td>
											<button
												type="button"
												aria-label={`${a.removed ? "Rétablir" : "Retirer"} l’action : ${n}`}
												onClick={() => {
													if (update(a, { removed: !a.removed }))
														setAnnounce(`Action ${a.removed ? "rétablie" : "retirée, gardée pour mémoire"} : ${n}`);
												}}
											>
												{a.removed ? "Rétablir" : "Retirer"}
											</button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</section>
			)}
			<form class="audit-add" onSubmit={addAction} noValidate>
				<div class="audit-field">
					<label for="schema-nouvelle-action">Intitulé d’une action libre</label>
					<p id="schema-nouvelle-action-aide" class="audit-help">
						Par exemple « Former l’équipe éditoriale » ou « Sous-titrer les vidéos ».
					</p>
					<input
						id="schema-nouvelle-action"
						type="text"
						value={newTitle}
						maxLength={MAX_TITLE}
						aria-invalid={newInvalid ? "true" : undefined}
						aria-describedby={`schema-nouvelle-action-aide${newInvalid ? " schema-nouvelle-action-erreur" : ""}`}
						onInput={(e) => setNewTitle((e.currentTarget as HTMLInputElement).value)}
					/>
					{newInvalid && (
						<p id="schema-nouvelle-action-erreur" class="audit-error">
							Saisissez l’intitulé de l’action.
						</p>
					)}
				</div>
				<button type="submit">Ajouter l’action</button>
			</form>

			<h3>Plan d’action annuel</h3>
			{year === undefined ? (
				<p>Choisissez la période du schéma : le plan d’action d’une année en découle.</p>
			) : (
				<div class="audit-field">
					<label for="schema-annee">Année du plan d’action</label>
					<p id="schema-annee-aide" class="audit-help">
						Le plan reprend les actions de cette année ; son bilan reprend la colonne « Bilan » des actions de l’année
						précédente.
					</p>
					<select
						id="schema-annee"
						aria-describedby="schema-annee-aide"
						value={year}
						onChange={(e) => setChosenYear(Number((e.currentTarget as HTMLSelectElement).value))}
					>
						{years.map((y) => (
							<option key={y} value={y}>
								{y}
							</option>
						))}
					</select>
				</div>
			)}

			<section aria-labelledby="schema-apercu" class="audit-schema-preview">
				<h3 id="schema-apercu">Aperçu du schéma pluriannuel</h3>
				<Preview blocks={schemaBlocks(session, r)} />
			</section>
			{year !== undefined && (
				<section aria-labelledby="plan-apercu" class="audit-schema-preview">
					<h3 id="plan-apercu">Aperçu du plan d’action {year}</h3>
					<Preview blocks={planBlocks(session, r, year)} />
				</section>
			)}
			<p class="audit-declaration-actions">
				<button type="button" onClick={() => download("schema", "html")}>
					Télécharger le schéma (HTML)
				</button>
				<button type="button" onClick={() => download("schema", "markdown")}>
					Télécharger le schéma (Markdown)
				</button>
				{year !== undefined && (
					<>
						<button type="button" onClick={() => download("plan", "html")}>
							Télécharger le plan d’action {year} (HTML)
						</button>
						<button type="button" onClick={() => download("plan", "markdown")}>
							Télécharger le plan d’action {year} (Markdown)
						</button>
					</>
				)}
			</p>
		</section>
	);
}
