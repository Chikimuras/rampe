/** Préfixe un chemin interne avec la base de déploiement (/rampe sur GitHub Pages). */
export const url = (path = "") => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/${path}`;
