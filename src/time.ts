const RFC3339_REGEX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const stripMilliseconds = (isoString: string): string => isoString.replace(/\.000Z$/, "Z");

const formatOffset = (offsetMinutes: number): string => {
  if (offsetMinutes === 0) return "Z";

  const sign = offsetMinutes > 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");

  return `${sign}${hours}:${minutes}`;
};

const formatInTimeZone = (date: Date, timeZone: string): string => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    if (part.type !== "literal") {
      acc[part.type] = part.value;
    }
    return acc;
  }, {});

  const year = parts.year?.padStart(4, "0");
  const month = parts.month;
  const day = parts.day;
  const hour = parts.hour;
  const minute = parts.minute;
  const second = parts.second;

  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error(`Failed to format date in time zone: ${timeZone}`);
  }

  const zonedMs = Date.UTC(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10) - 1,
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
  );
  const offsetMinutes = Math.round((zonedMs - date.getTime()) / 60000);

  return `${year}-${month}-${day}T${hour}:${minute}:${second}${formatOffset(offsetMinutes)}`;
};

export const toDate = (rfc3339: string): Date => {
  if (!RFC3339_REGEX.test(rfc3339)) {
    throw new Error(`Invalid RFC3339 string: ${rfc3339}`);
  }

  const date = new Date(rfc3339);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Unable to parse date: ${rfc3339}`);
  }

  return date;
};

export const toRFC3339 = (date: Date, timeZone = "UTC"): string => {
  if (Number.isNaN(date.getTime())) {
    throw new Error("Invalid Date object passed to toRFC3339");
  }

  if (timeZone === "UTC") {
    return stripMilliseconds(date.toISOString());
  }

  return formatInTimeZone(date, timeZone);
};

export const isAfter = (a: string | Date, b: string | Date): boolean => {
  const dateA = a instanceof Date ? a : toDate(a);
  const dateB = b instanceof Date ? b : toDate(b);

  return dateA.getTime() > dateB.getTime();
};
