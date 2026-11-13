/**
 * Wraps text in curly double quotes. Text from the game already puts a job title in straight double
 * quotes (`proofread "Logo brief"`), so those become single quotes inside: one level of each.
 */
export const quoted = (text: string): string => `“${text.replace(/"([^"]*)"/g, '‘$1’')}”`;
