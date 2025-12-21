import type { Logger } from '@outburn/types';

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

export const defaultLogger: Logger = {
  info: (msg: any) => console.log(msg),
  warn: (msg: any) => console.warn(msg),
  error: (msg: any) => console.error(msg)
};

export const defaultPrethrow = (msg: Error | any): Error => {
  if (msg instanceof Error) {
    return msg;
  }
  const error = new Error(msg);
  return error;
};

export const customPrethrower = (logger: Logger) => {
  return (msg: Error | any): Error => {
    if (msg instanceof Error) {
      logger.error(msg);
      return msg;
    }
    const error = new Error(msg);
    logger.error(error);
    return error;
  };
};