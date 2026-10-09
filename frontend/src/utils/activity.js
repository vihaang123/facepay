const TITLES = {
  SENT: (n) => `Paid ${n}`,
  RECEIVED: (n) => `Received from ${n}`,
  REQUESTED: (n) => `You asked ${n}`,
  REQUEST_RECEIVED: (n) => `${n} asked you`,
}

export const activityTitle = (a) => (TITLES[a.direction] ?? ((n) => n))(a.counterparty_name ?? 'someone')
