export interface Rule {
  id: string;
  folder: string;
  category: string;
  match: (from: string, subject: string) => boolean;
}

const lc = (s: string) => (s ?? "").toLowerCase();
const fromIncludes = (from: string, ...needles: string[]) => {
  const f = lc(from);
  return needles.some((n) => f.includes(n.toLowerCase()));
};
const subjectIncludes = (subject: string, ...needles: string[]) => {
  const s = lc(subject);
  return needles.some((n) => s.includes(n.toLowerCase()));
};

export const RULES: Rule[] = [
  {
    id: "banking-acb",
    folder: "Banking/ACB",
    category: "Red category",
    match: (from) => fromIncludes(from, "acb.com.vn", "acb-notification"),
  },
  {
    id: "banking-mbbank",
    folder: "Banking/MBBank",
    category: "Red category",
    match: (from) => fromIncludes(from, "mbbank.com.vn", "mbcard"),
  },
  {
    id: "banking-techcombank",
    folder: "Banking/Techcombank",
    category: "Red category",
    match: (from) => fromIncludes(from, "techcombank.com"),
  },
  {
    id: "banking-vib",
    folder: "Banking/VIB",
    category: "Red category",
    match: (from) => fromIncludes(from, "vib.com.vn"),
  },
  {
    id: "banking-vcb",
    folder: "Banking/VCB",
    category: "Red category",
    match: (from) => fromIncludes(from, "vietcombank.com.vn"),
  },
  {
    id: "banking-vpbanks",
    folder: "Banking/VPBankS",
    category: "Red category",
    match: (from) => fromIncludes(from, "vpbanks.com.vn", "vpbank"),
  },
  {
    id: "security",
    folder: "Security",
    category: "Orange category",
    match: (from, subject) =>
      fromIncludes(from, "accountprotection.microsoft.com", "account-security") ||
      subjectIncludes(subject, "OTP", "xác thực", "verification"),
  },
  {
    id: "promotions",
    folder: "Promotions",
    category: "Yellow category",
    match: (_from, subject) => {
      const s = lc(subject);
      return (
        s.startsWith("[qc]") ||
        subjectIncludes(subject, "khuyến mãi", "ưu đãi", "miễn phí", "promotion")
      );
    },
  },
  {
    id: "newsletters",
    folder: "Newsletters",
    category: "Blue category",
    match: (from, subject) =>
      subjectIncludes(subject, "Thông báo kết quả kinh doanh", "báo cáo") ||
      fromIncludes(from, "ir@"),
  },
];

export function classify(from: string, subject: string): Rule | null {
  for (const rule of RULES) {
    if (rule.match(from, subject)) return rule;
  }
  return null;
}
