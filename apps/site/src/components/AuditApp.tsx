// Audit guidé (ADR-0013) : le seul îlot JavaScript du site. Modèle et opérations : @rampe/core/audit-session.
// Imports par sous-chemin : l'îlot n'embarque ni le référentiel ni axe-core, seulement les données reçues en props.
import {
	type AuditSession,
	addPage,
	createSession,
	getEvaluation,
	parseSession,
	progress,
	removePage,
	type SessionPage,
	type Status,
	setEvaluation,
} from "@rampe/core/audit-session";
import { parseAuditUrl, parseSampleFile, plural } from "@rampe/core/sample-file";
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
	tests: { id: string; statementHtml: string; conditionsHtml: string[]; methodologyHtml: string }[];
	href: string;
}

type Filter = "all" | "NT" | "NC";

const STORAGE_KEY = "rampe.audit.session";
const SAVE_DELAY = 400;
const STATUS_LABELS: [Status, string][] = [
	["C", "Conforme"],
	["NC", "Non conforme"],
	["NA", "Non applicable"],
	["NT", "Non testé"],
];
const FILTERS: [Filter, string][] = [
	["all", "Tous les critères"],
	["NT", "Critères avec des pages non testées"],
	["NC", "Critères non conformes sur au moins une page"],
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

/** `ignored` : une valeur était présente mais illisible ; elle est mise de côté, jamais réutilisée. */
function loadSession(): { session: AuditSession | null; ignored: boolean } {
	let raw: string | null;
	try {
		raw = localStorage.getItem(STORAGE_KEY);
	} catch {
		return { session: null, ignored: false };
	}
	if (raw === null) return { session: null, ignored: false };
	let session: AuditSession | null = null;
	try {
		session = parseSession(JSON.parse(raw));
	} catch {}
	if (session) return { session, ignored: false };
	try {
		localStorage.setItem(`${STORAGE_KEY}.ignoree`, raw);
	} catch {}
	return { session: null, ignored: true };
}

function saveSession(session: AuditSession): boolean {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
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

export default function AuditApp({ topics, criteria }: { topics: AuditTopic[]; criteria: AuditCriterion[] }) {
	const [session, setSession] = useState<AuditSession>(() => createSession());
	const [ready, setReady] = useState(false);
	const [storageOk, setStorageOk] = useState(true);
	const [ignored, setIgnored] = useState(false);
	const [currentId, setCurrentId] = useState(criteria[0]?.id ?? "");
	const [filter, setFilter] = useState<Filter>("all");
	const [announce, setAnnounce] = useState("");
	const headingRef = useRef<HTMLHeadingElement>(null);
	/** Dernière session écrite ou relue : on n'écrit (et n'annonce « Enregistré ») qu'après un vrai changement. */
	const saved = useRef<AuditSession>(session);
	const focusHeading = useRef(false);

	// Reprise de la session au chargement (côté client uniquement : le rendu du build part d'une session vide).
	useEffect(() => {
		const ok = storageAvailable();
		setStorageOk(ok);
		if (ok) {
			const { session: stored, ignored: wasIgnored } = loadSession();
			if (stored) {
				saved.current = stored;
				setSession(stored);
			}
			setIgnored(wasIgnored);
		}
		setReady(true);
	}, []);

	// Sauvegarde automatique, différée pour ne pas écrire à chaque frappe dans une note.
	const pending = useRef<AuditSession | null>(null);
	useEffect(() => {
		if (!ready || !storageOk || session === saved.current) return;
		pending.current = session;
		const timer = setTimeout(() => {
			pending.current = null;
			saved.current = session;
			if (saveSession(session)) setAnnounce("Enregistré");
			else setStorageOk(false);
		}, SAVE_DELAY);
		return () => clearTimeout(timer);
	}, [session, ready, storageOk]);
	// Fermeture de l'onglet pendant le délai : on écrit tout de suite.
	useEffect(() => {
		const flush = () => {
			if (pending.current) saveSession(pending.current);
		};
		addEventListener("pagehide", flush);
		return () => removeEventListener("pagehide", flush);
	}, []);

	useLayoutEffect(() => {
		if (focusHeading.current) {
			focusHeading.current = false;
			headingRef.current?.focus();
		}
	}, [currentId]);

	const prog = useMemo(() => progress(session, criteria), [session, criteria]);
	const matches = (c: AuditCriterion) => {
		if (filter === "all") return true;
		return session.pages.some((p) => getEvaluation(session, c.id, p.id).status === filter);
	};
	const visible = criteria.filter(matches);
	const index = criteria.findIndex((c) => c.id === currentId);
	const current = criteria[index] ?? criteria[0];
	const prev = criteria.slice(0, Math.max(index, 0)).findLast(matches);
	const next = criteria.slice(index + 1).find(matches);

	const goTo = (id: string) => {
		focusHeading.current = true;
		setCurrentId(id);
		if (id === currentId) headingRef.current?.focus();
	};
	const chooseTopic = (topic: number) => {
		const first = visible.find((c) => c.topic === topic) ?? criteria.find((c) => c.topic === topic);
		if (first) setCurrentId(first.id);
	};
	const changeFilter = (f: Filter) => {
		setFilter(f);
		const n =
			f === "all"
				? criteria.length
				: criteria.filter((c) => session.pages.some((p) => getEvaluation(session, c.id, p.id).status === f)).length;
		setAnnounce(`${plural(n, "critère")} affiché${n > 1 ? "s" : ""}`);
	};
	const restart = () => {
		if (!confirm("Effacer toutes les pages et toutes les évaluations de cet audit ? Cette action est définitive."))
			return;
		setSession(createSession());
		setCurrentId(criteria[0]?.id ?? "");
		setAnnounce("Audit effacé : vous repartez de zéro.");
	};

	if (!current) return null;
	const topic = topics.find((t) => t.number === current.topic);

	return (
		<div class="audit">
			{!storageOk && (
				<p class="audit-banner">
					<strong>Votre travail ne sera pas conservé si vous fermez cette page.</strong> Le stockage local de ce
					navigateur est indisponible (navigation privée, stockage plein ou refusé).
				</p>
			)}
			{ignored && (
				<p class="audit-banner">
					Une session enregistrée n’a pas pu être relue (format inconnu ou abîmé) : elle a été mise de côté et un nouvel
					audit commence.
				</p>
			)}

			<Pages session={session} setSession={setSession} setAnnounce={setAnnounce} />

			<section aria-labelledby="audit-criteres" class="audit-eval">
				<h2 id="audit-criteres">2. Évaluer les critères</h2>
				{session.pages.length > 0 ? (
					<p class="audit-progress">
						<label for="audit-avancement">
							Il reste {plural(prog.total.remaining, "évaluation")} « non testé » sur {prog.total.total}
						</label>
						<progress id="audit-avancement" max={prog.total.total} value={prog.total.total - prog.total.remaining} />
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
										aria-current={t.number === current.topic ? "true" : undefined}
										onClick={() => chooseTopic(t.number)}
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

				<nav aria-labelledby="audit-liste" class="audit-list">
					<h3 id="audit-liste">
						Critères de la thématique {current.topic}
						{filter !== "all" && " (filtrés)"}
					</h3>
					{visible.some((c) => c.topic === current.topic) ? (
						<ul>
							{visible
								.filter((c) => c.topic === current.topic)
								.map((c) => (
									<li key={c.id}>
										<button
											type="button"
											aria-current={c.id === current.id ? "true" : undefined}
											onClick={() => goTo(c.id)}
										>
											<span class="audit-num">{c.id}</span>
											<span {...trustedBuildHtml(c.titleTextHtml)} />
											<CriterionSummary session={session} id={c.id} />
										</button>
									</li>
								))}
						</ul>
					) : (
						<p>Aucun critère de cette thématique ne correspond au filtre.</p>
					)}
				</nav>

				<article class="audit-criterion" aria-labelledby="audit-titre">
					<h3 id="audit-titre" ref={headingRef} tabIndex={-1}>
						<span class="audit-num">Critère {current.id}</span> <span {...trustedBuildHtml(current.titleHtml)} />
					</h3>
					<p class="audit-official">
						Texte officiel du RGAA. <a href={current.href}>Fiche complète du critère {current.id}</a>
					</p>
					{topic && (
						<div class="rampe-note">
							<p class="label">Explication Rampe — non normative (thématique « {topic.title} »)</p>
							<p>{topic.intro}</p>
						</div>
					)}
					<details open>
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

					{session.pages.length > 0 && (
						<div class="audit-pages-eval">
							<h4>Statut par page</h4>
							{session.pages.map((p) => (
								<PageEvaluation
									key={`${current.id}-${p.id}`}
									criterionId={current.id}
									page={p}
									session={session}
									setSession={setSession}
								/>
							))}
						</div>
					)}

					<nav aria-label="Critères voisins" class="audit-pager">
						{prev && (
							<button type="button" onClick={() => goTo(prev.id)}>
								Critère précédent : {prev.id}
							</button>
						)}
						{next && (
							<button type="button" class="audit-next" onClick={() => goTo(next.id)}>
								Critère suivant : {next.id}
							</button>
						)}
					</nav>
				</article>
			</section>

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

function CriterionSummary({ session, id }: { session: AuditSession; id: string }) {
	if (session.pages.length === 0) return null;
	const statuses = session.pages.map((p) => getEvaluation(session, id, p.id).status);
	const nc = statuses.filter((s) => s === "NC").length;
	const nt = statuses.filter((s) => s === "NT").length;
	const parts = [nc > 0 && `${nc} non conforme${nc > 1 ? "s" : ""}`, nt > 0 && `${nt} non testé${nt > 1 ? "s" : ""}`];
	return <span class="audit-count">{parts.filter(Boolean).join(", ") || "évalué"}</span>;
}

function PageEvaluation({
	criterionId,
	page,
	session,
	setSession,
}: {
	criterionId: string;
	page: SessionPage;
	session: AuditSession;
	setSession: (update: (s: AuditSession) => AuditSession) => void;
}) {
	const evaluation = getEvaluation(session, criterionId, page.id);
	const noteId = `note-${criterionId}-${page.id}`;
	const update = (patch: { status?: Status; note?: string }) =>
		setSession((s) => setEvaluation(s, criterionId, page.id, patch));
	return (
		<fieldset class="audit-page">
			<legend>
				{pageName(page)}
				{page.title.trim() && <span class="audit-url"> ({page.url})</span>}
			</legend>
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
			<label for={noteId}>Note (facultative)</label>
			<textarea id={noteId} rows={2} value={evaluation.note} onInput={(e) => update({ note: e.currentTarget.value })} />
		</fieldset>
	);
}

function Pages({
	session,
	setSession,
	setAnnounce,
}: {
	session: AuditSession;
	setSession: (update: AuditSession | ((s: AuditSession) => AuditSession)) => void;
	setAnnounce: (message: string) => void;
}) {
	const [url, setUrl] = useState("");
	const [title, setTitle] = useState("");
	const [urlError, setUrlError] = useState("");
	const [sample, setSample] = useState("");
	const [sampleMessage, setSampleMessage] = useState<{ error: boolean; text: string } | null>(null);
	const urlRef = useRef<HTMLInputElement>(null);
	const sampleRef = useRef<HTMLTextAreaElement>(null);

	/** Contrôle commun à la saisie et au collage : http(s), un seul site, pas de doublon. */
	const check = (s: AuditSession, u: URL): string | null => {
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
		setSession((s) => removePage(s, p.id));
		setAnnounce(`Page retirée : ${pageName(p)}`);
	};

	return (
		<section aria-labelledby="audit-echantillon" class="audit-sample">
			<h2 id="audit-echantillon">1. Pages de l’échantillon</h2>
			{session.pages.length > 0 ? (
				<ol class="audit-page-list">
					{session.pages.map((p) => (
						<li key={p.id}>
							<span>
								{pageName(p)}
								{p.title.trim() && <span class="audit-url"> {p.url}</span>}
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
					<input id="audit-titre-page" type="text" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
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
		</section>
	);
}
