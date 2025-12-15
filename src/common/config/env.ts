export const envNumber = (key: string, defaultValue: number): number => {
  const value = Number(process.env[key]);
  if (Number.isFinite(value) && value > 0) {
    return value;
  }
  return defaultValue;
};

