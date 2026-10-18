// Every palette supplies the same semantic roles. This keeps the visual
// hierarchy stable while letting a deck move between genuinely different
// colour worlds without per-slide overrides.
export const palettes = [
  {
    id: "ivory-pine",
    name: "Ivory & Pine",
    swatches: ["#253746", "#2F6B55", "#C46B35", "#E7F0E8"],
    tokens: {
      canvas: "#FFFCF6", ink: "#253746", body: "#52616B", muted: "#7A8586", line: "#D9E2DE",
      labelSurface: "#E7F0E8", mutedSurface: "#EEF4EF", softSurface: "#D7E7DC",
      roadmap: "#2F6B55", onDark: "#FFFFFF", accent: "#C46B35", accentSoft: "#F3DDCB", accentAlt: "#5F8D7A",
      timelineBase: "#91A79D", timelineResearch: "#2F6B55", timelineMentoring: "#5F8D7A",
      timelineBsc: "#C7D7CE", timelineMsc: "#8FAF9F", timelinePhd: "#456F5E", timelineFulltime: "#254E41",
      timelineExchange: "#B2C8BC", timelineService: "#769B89", legacy: "#AFC4B7",
    },
  },
  {
    id: "alpine-blue",
    name: "Alpine Blue",
    swatches: ["#17324D", "#0B6E99", "#E0853A", "#DCEEF5"],
    tokens: {
      canvas: "#FBFDFF", ink: "#17324D", body: "#4E6579", muted: "#798B9A", line: "#D7E3EA",
      labelSurface: "#DCEEF5", mutedSurface: "#EEF6F9", softSurface: "#CBE4EE",
      roadmap: "#0B6E99", onDark: "#FFFFFF", accent: "#E0853A", accentSoft: "#F8E3D0", accentAlt: "#4B91B7",
      timelineBase: "#94B5C4", timelineResearch: "#0B6E99", timelineMentoring: "#4B91B7",
      timelineBsc: "#C9E0E8", timelineMsc: "#8AB9CC", timelinePhd: "#397EA4", timelineFulltime: "#245E7D",
      timelineExchange: "#B7D3DE", timelineService: "#70A9BF", legacy: "#A9C8D5",
    },
  },
  {
    id: "terracotta",
    name: "Terracotta",
    swatches: ["#3F312B", "#A6503B", "#D99955", "#F4E5D8"],
    tokens: {
      canvas: "#FFFDF9", ink: "#3F312B", body: "#65534A", muted: "#8B796E", line: "#E8DCD2",
      labelSurface: "#F4E5D8", mutedSurface: "#FAF0E8", softSurface: "#EED6C4",
      roadmap: "#A6503B", onDark: "#FFFFFF", accent: "#D08A42", accentSoft: "#F7E3C9", accentAlt: "#B96D55",
      timelineBase: "#C7A697", timelineResearch: "#A6503B", timelineMentoring: "#B96D55",
      timelineBsc: "#E7CDC0", timelineMsc: "#D29A84", timelinePhd: "#8A4A39", timelineFulltime: "#653429",
      timelineExchange: "#DFC1B0", timelineService: "#BD7F67", legacy: "#D1B09E",
    },
  },
  {
    id: "indigo-iris",
    name: "Indigo Iris",
    swatches: ["#2B2D5C", "#5154A6", "#B6783A", "#E8E7F7"],
    tokens: {
      canvas: "#FEFDFF", ink: "#2B2D5C", body: "#5B5D7B", muted: "#85869E", line: "#DEDEF0",
      labelSurface: "#E8E7F7", mutedSurface: "#F1F0FA", softSurface: "#D9D9F0",
      roadmap: "#5154A6", onDark: "#FFFFFF", accent: "#B6783A", accentSoft: "#F1DFC8", accentAlt: "#7B7DC0",
      timelineBase: "#AAAAD0", timelineResearch: "#5154A6", timelineMentoring: "#7B7DC0",
      timelineBsc: "#D4D4EB", timelineMsc: "#9B9DCC", timelinePhd: "#424488", timelineFulltime: "#303266",
      timelineExchange: "#C4C4E3", timelineService: "#7375B4", legacy: "#BCBDE0",
    },
  },
  {
    id: "coastal-teal",
    name: "Coastal Teal",
    swatches: ["#174A52", "#087E8B", "#D86C4A", "#D9F0EE"],
    tokens: {
      canvas: "#FCFFFE", ink: "#174A52", body: "#4D696D", muted: "#788E90", line: "#D3E8E6",
      labelSurface: "#D9F0EE", mutedSurface: "#EDF8F7", softSurface: "#C6E6E3",
      roadmap: "#087E8B", onDark: "#FFFFFF", accent: "#D86C4A", accentSoft: "#F7DDD3", accentAlt: "#4EA4A8",
      timelineBase: "#95BFBD", timelineResearch: "#087E8B", timelineMentoring: "#4EA4A8",
      timelineBsc: "#C7E4E2", timelineMsc: "#89C2C2", timelinePhd: "#237B81", timelineFulltime: "#185A61",
      timelineExchange: "#B4D8D5", timelineService: "#6AAFB0", legacy: "#ADD3D0",
    },
  },
  {
    id: "plum-brass",
    name: "Plum & Brass",
    swatches: ["#3E2841", "#7C3F6E", "#B27A27", "#F0E3EE"],
    tokens: {
      canvas: "#FFFCFF", ink: "#3E2841", body: "#665267", muted: "#8D7A8E", line: "#E7DCE6",
      labelSurface: "#F0E3EE", mutedSurface: "#F8EFF7", softSurface: "#E6D0E2",
      roadmap: "#7C3F6E", onDark: "#FFFFFF", accent: "#B27A27", accentSoft: "#F1DFC1", accentAlt: "#A06B98",
      timelineBase: "#C6A9C1", timelineResearch: "#7C3F6E", timelineMentoring: "#A06B98",
      timelineBsc: "#E4CEE1", timelineMsc: "#C18AB5", timelinePhd: "#643558", timelineFulltime: "#4B2944",
      timelineExchange: "#D8BCD3", timelineService: "#AD78A4", legacy: "#D0B2CB",
    },
  },
  {
    id: "ochre-sand",
    name: "Ochre & Sand",
    swatches: ["#3D3428", "#946000", "#B75C36", "#F5EBCF"],
    tokens: {
      canvas: "#FFFEF9", ink: "#3D3428", body: "#665A48", muted: "#8A806F", line: "#E8DFC8",
      labelSurface: "#F5EBCF", mutedSurface: "#FCF5E4", softSurface: "#EDDCAD",
      roadmap: "#946000", onDark: "#FFFFFF", accent: "#B75C36", accentSoft: "#F3DACA", accentAlt: "#B58B40",
      timelineBase: "#C5B285", timelineResearch: "#946000", timelineMentoring: "#B58B40",
      timelineBsc: "#E8DDBB", timelineMsc: "#C8A75B", timelinePhd: "#765017", timelineFulltime: "#584015",
      timelineExchange: "#DAC9A0", timelineService: "#AD8436", legacy: "#D5C49A",
    },
  },
  {
    id: "slate-coral",
    name: "Slate & Coral",
    swatches: ["#263E54", "#3D748A", "#C85C5C", "#E0EBF0"],
    tokens: {
      canvas: "#FCFEFF", ink: "#263E54", body: "#536A7B", muted: "#7D909D", line: "#D9E4EA",
      labelSurface: "#E0EBF0", mutedSurface: "#F0F6F8", softSurface: "#CFE0E7",
      roadmap: "#3D748A", onDark: "#FFFFFF", accent: "#C85C5C", accentSoft: "#F4D8D8", accentAlt: "#719CB0",
      timelineBase: "#9EB9C5", timelineResearch: "#3D748A", timelineMentoring: "#719CB0",
      timelineBsc: "#CFE0E7", timelineMsc: "#91B7C7", timelinePhd: "#315E74", timelineFulltime: "#24495B",
      timelineExchange: "#BDD2DC", timelineService: "#79A7BA", legacy: "#B7CFD9",
    },
  },
  {
    id: "rosewood",
    name: "Rosewood",
    swatches: ["#442D35", "#9D455A", "#C98945", "#F4E2E5"],
    tokens: {
      canvas: "#FFFCFC", ink: "#442D35", body: "#695159", muted: "#907780", line: "#E9D9DD",
      labelSurface: "#F4E2E5", mutedSurface: "#FCEFF1", softSurface: "#EBCDD3",
      roadmap: "#9D455A", onDark: "#FFFFFF", accent: "#C98945", accentSoft: "#F5E0C7", accentAlt: "#B56C7C",
      timelineBase: "#C8A7AF", timelineResearch: "#9D455A", timelineMentoring: "#B56C7C",
      timelineBsc: "#E7CDD2", timelineMsc: "#C98D9A", timelinePhd: "#823A4B", timelineFulltime: "#612E3A",
      timelineExchange: "#DCBBC3", timelineService: "#B67484", legacy: "#D5B4BC",
    },
  },
  {
    id: "moss-stone",
    name: "Moss & Stone",
    swatches: ["#293C32", "#557A4E", "#B66B37", "#E6EDDC"],
    tokens: {
      canvas: "#FDFEF9", ink: "#293C32", body: "#56665B", muted: "#7D8B81", line: "#DCE5DA",
      labelSurface: "#E6EDDC", mutedSurface: "#F1F5EB", softSurface: "#D5E0CC",
      roadmap: "#557A4E", onDark: "#FFFFFF", accent: "#B66B37", accentSoft: "#F3DDCD", accentAlt: "#7E9B70",
      timelineBase: "#AABDA7", timelineResearch: "#557A4E", timelineMentoring: "#7E9B70",
      timelineBsc: "#D5E0D2", timelineMsc: "#9BBC90", timelinePhd: "#46683F", timelineFulltime: "#364F31",
      timelineExchange: "#C2D0BE", timelineService: "#78966E", legacy: "#C1D1BA",
    },
  },
];

export const defaultPalette = palettes[0].id;
