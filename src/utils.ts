export const initCap = (str: string): string => {
  return str.charAt(0).toUpperCase() + str.slice(1);
};

export const splitFshPath = (path: string): string[] => {
  const segments: string[] = [];
  let current = '';
  let inBrackets = false;

  for (const char of path) {
    if (char === '[') inBrackets = true;
    if (char === ']') inBrackets = false;

    if (char === '.' && !inBrackets) {
      segments.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current) segments.push(current);
  return segments;
};