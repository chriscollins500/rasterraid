export function subjectScore(matches, exclusions) {
  const positive = matches.length === 1 ? matches[0] :
    .75 * matches.reduce((sum, value) => sum + value, 0) / matches.length + .25 * Math.min(...matches);
  return positive - .55 * Math.max(0, ...exclusions);
}
