/**
 * Conservative token estimate for sizing Jev requests.
 *
 * Faithful port of fast-jev's character-class estimator, measured 9-16% above
 * the API's true token count, so budgets under-fill rather than overflow.
 * Alphabetic runs cost 1 + floor((len - 1) / 6); digit runs cost len / 2; other
 * glyphs cost 0.9 each; whitespace is free. Do not retune the constants without
 * re-measuring against the live API.
 */
export function estimateJevTokens(text: string): number {
	let tokens = 0;
	for (const [piece] of text.matchAll(/[A-Za-z]+|\d+|[^\sA-Za-z\d]/g)) {
		const first = piece.charCodeAt(0);
		if (first >= 48 && first <= 57) {
			tokens += piece.length / 2;
		} else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
			tokens += 1 + Math.floor((piece.length - 1) / 6);
		} else {
			tokens += 0.9;
		}
	}
	return Math.ceil(tokens);
}
