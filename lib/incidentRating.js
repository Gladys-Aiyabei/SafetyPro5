// =====================================================
// INCIDENT RATING: likelihood (1-5) x consequence (1-5), 5 x 5 risk matrix
// Used by the investigation page and the learning alert PDF.
// =====================================================

const LIKELIHOOD = ["Rare", "Unlikely", "Possible", "Likely", "Almost Certain"];
const CONSEQUENCE = ["Insignificant", "Minor", "Moderate", "Major", "Catastrophic"];

const BAND_COLOURS = {
    Low: "#198754",
    Medium: "#ffc107",
    High: "#fd7e14",
    Extreme: "#dc3545"
};

// incident row -> { score, band, colour, likelihood, consequence } or null when not rated
function rating(incident) {

    const l = Number(incident.likelihood);
    const c = Number(incident.consequence);

    if (!(l >= 1 && l <= 5 && c >= 1 && c <= 5)) return null;

    const score = l * c;
    const band = score >= 20 ? "Extreme" : score >= 10 ? "High" : score >= 5 ? "Medium" : "Low";

    return {
        score,
        band,
        colour: BAND_COLOURS[band],
        likelihood: LIKELIHOOD[l - 1],
        consequence: CONSEQUENCE[c - 1]
    };
}

module.exports = { LIKELIHOOD, CONSEQUENCE, rating };
