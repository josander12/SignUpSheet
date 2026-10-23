export function padTime(value) {
  return value.toString().padStart(2, "0");
}

export function toMinutes(timeString) {
  const [hours, minutes] = timeString.split(":").map(Number);
  return hours * 60 + minutes;
}

export function formatTime(timeString) {
  const [hours, minutes] = timeString.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatDate(dateString) {
  const date = parseDateValue(dateString);
  if (!date) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDateValue(dateValue) {
  if (!dateValue) {
    return null;
  }

  const [year, month, day] = dateValue.split("-").map(Number);
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null;
  }

  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

export function getNextAvailableDate(date = new Date()) {
  const candidate = new Date(date);
  candidate.setHours(12, 0, 0, 0);

  while (![1, 3, 6].includes(candidate.getDay())) {
    candidate.setDate(candidate.getDate() + 1);
  }

  return toDateInputValue(candidate);
}

export function getAllowedWindow(dateValue) {
  if (!dateValue) {
    return null;
  }

  const date = parseDateValue(dateValue);
  if (!date) {
    return null;
  }

  const weekday = date.getDay();

  if (weekday === 1 || weekday === 3) {
    return { label: "Monday/Wednesday", start: "11:45", end: "17:45" };
  }

  if (weekday === 6) {
    return { label: "Saturday", start: "08:30", end: "14:00" };
  }

  return null;
}

export function isPastDate(dateValue) {
  if (!dateValue) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const date = parseDateValue(dateValue);
  if (!date) {
    return false;
  }

  date.setHours(0, 0, 0, 0);

  return date < today;
}

export function buildTimeOptions(start, end) {
  const options = [];
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);

  for (let minutes = startMinutes; minutes <= endMinutes; minutes += 15) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    const formatted = `${padTime(hours)}:${padTime(mins)}`;
    options.push(formatted);
  }

  return options;
}
