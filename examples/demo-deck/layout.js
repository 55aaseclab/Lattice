export default {
  slides: [
    {
      id: "intro",
      template: "title-slide",
      grid: {
        columns: 12,
        rows: 8,
        gap: "md",
      },
      elements: [
        {
          id: "title",
          type: "text",
          bind: "title",
          placement: {
            column: 1,
            row: 2,
            columnSpan: 12,
            rowSpan: 2,
          },
        },
        {
          id: "subtitle",
          type: "text",
          bind: "subtitle",
          placement: {
            column: 1,
            row: 4,
            columnSpan: 12,
            rowSpan: 1,
          },
        },
      ],
    },
    {
      id: "grid",
      template: "title-body",
      grid: {
        columns: 12,
        rows: 8,
        gap: "md",
      },
      elements: [
        {
          id: "title",
          type: "text",
          bind: "title",
          placement: {
            column: 1,
            row: 1,
            columnSpan: 12,
            rowSpan: 1,
          },
        },
        {
          id: "body",
          type: "text",
          bind: "body",
          placement: {
            column: 1,
            row: 2,
            columnSpan: 12,
            rowSpan: 5,
          },
        },
      ],
    },
  ],
};
