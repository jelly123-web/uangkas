const months = Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1).padStart(2, '0') }));

function parseWeekNumberFromText(value) {
  const text = String(value ?? "");
  const match = text.match(/minggu\s*(?:ke)?\s*(\d+)/i);
  const weekNumber = Number(match?.[1] ?? 0);
  return weekNumber >= 1 && weekNumber <= 4 ? weekNumber : null;
}

function parseMonthValueFromText(value) {
  const text = String(value ?? "").toLowerCase();

  if (!text) {
    return null;
  }

  const monthAliases = [
    ["01", ["januari", "january", "jan"]],
    ["02", ["februari", "february", "feb"]],
    ["03", ["maret", "march", "mar"]],
    ["04", ["april", "apr"]],
    ["05", ["mei", "may"]],
    ["06", ["juni", "june", "jun"]],
    ["07", ["juli", "july", "jul"]],
    ["08", ["agustus", "august", "agu", "aug"]],
    ["09", ["september", "sep"]],
    ["10", ["oktober", "october", "okt", "oct"]],
    ["11", ["november", "nov"]],
    ["12", ["desember", "december", "des", "dec"]]
  ];

  for (const [monthValue, aliases] of monthAliases) {
    if (aliases.some((alias) => text.includes(alias))) {
      return monthValue;
    }
  }

  return null;
}

function buildAcademicMonthSequence(academicYearName = "", fallbackDate = new Date()) {
  const match = String(academicYearName ?? "").match(/(\d{4})\s*\/\s*(\d{4})/);

  if (!match) {
    const currentYear = fallbackDate.getFullYear();
    return months.map((item) => ({
      ...item,
      year: currentYear,
      key: `${currentYear}-${item.value}`
    }));
  }

  const startYear = Number(match[1]);
  const endYear = Number(match[2]);
  return [
    ...months.filter((item) => Number(item.value) >= 7).map((item) => ({
      ...item,
      year: startYear,
      key: `${startYear}-${item.value}`
    })),
    ...months.filter((item) => Number(item.value) <= 6).map((item) => ({
      ...item,
      year: endYear,
      key: `${endYear}-${item.value}`
    }))
  ];
}

function getAcademicYearForMonth(monthValue, academicYearName = "", fallbackDate = new Date()) {
  const monthNumber = Number(monthValue);
  const monthSequence = buildAcademicMonthSequence(academicYearName, fallbackDate);
  const matchedMonth = monthSequence.find((item) => Number(item.value) === monthNumber);
  return matchedMonth?.year ?? fallbackDate.getFullYear();
}

function allocateCashPaymentsByAcademicMonths(students = [], transactions = [], academicYearName = "", fallbackDate = new Date()) {
  const monthSequence = buildAcademicMonthSequence(academicYearName, fallbackDate);
  const monthIndexMap = new Map(monthSequence.map((item, index) => [item.key, index]));
  const totalSlots = monthSequence.length * 4;
  const studentSlots = new Map(
    (students ?? []).map((student) => [student.id, Array.from({ length: totalSlots }, () => 0)])
  );

  const cashTransactions = (transactions ?? [])
    .filter(
      (item) =>
        item.type === "income" &&
        String(item.category ?? "").toLowerCase() !== "denda" &&
        item.student_id &&
        monthIndexMap.has(
          `${new Date(item.created_at).getFullYear()}-${String(new Date(item.created_at).getMonth() + 1).padStart(2, "0")}`
        )
    )
    .slice()
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || Number(a.id) - Number(b.id)
    );

  for (const item of cashTransactions) {
    const slots = studentSlots.get(item.student_id);
    const student = (students ?? []).find((entry) => Number(entry.id) === Number(item.student_id));

    if (!slots || !student) {
      continue;
    }

    const createdAt = new Date(item.created_at);
    const requestedMonthValue = parseMonthValueFromText(`${item.title ?? ""} ${item.note ?? ""}`);
    const requestedMonthYear =
      requestedMonthValue && Number(requestedMonthValue) >= 7
        ? monthSequence.find((entry) => entry.value === requestedMonthValue)?.year
        : monthSequence.find((entry) => entry.value === requestedMonthValue)?.year;
    const monthKey = requestedMonthValue && requestedMonthYear
      ? `${requestedMonthYear}-${requestedMonthValue}`
      : `${createdAt.getFullYear()}-${String(createdAt.getMonth() + 1).padStart(2, "0")}`;
    const monthIndex = monthIndexMap.get(monthKey);

    if (monthIndex === undefined) {
      continue;
    }

    const weeklyNominal = Math.max(Number(student.nominalKas ?? 0), 0);
    let remaining = Math.max(Number(item.amount ?? 0), 0);

    if (remaining <= 0) {
      continue;
    }

    const explicitWeek = parseWeekNumberFromText(item.title || item.note);
    let slotIndex = explicitWeek
      ? monthIndex * 4 + (explicitWeek - 1)
      : slots.findIndex((value, index) => index >= monthIndex * 4 && value < weeklyNominal);

    if (slotIndex < 0) {
      slotIndex = monthIndex * 4;
    }

    while (remaining > 0 && slotIndex < slots.length) {
      if (weeklyNominal <= 0) {
        slots[slotIndex] += remaining;
        remaining = 0;
        break;
      }

      const slotRemaining = Math.max(weeklyNominal - slots[slotIndex], 0);

      if (slotRemaining <= 0) {
        slotIndex += 1;
        continue;
      }

      const allocation = Math.min(slotRemaining, remaining);
      slots[slotIndex] += allocation;
      remaining -= allocation;

      if (slots[slotIndex] >= weeklyNominal) {
        slotIndex += 1;
      }
    }
  }

  return { monthSequence, studentSlots };
}

export { allocateCashPaymentsByAcademicMonths };
