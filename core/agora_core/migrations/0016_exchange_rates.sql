-- Euro reference rates of the European Central Bank, per day and currency (how many euros one unit is worth).
CREATE TABLE exchange_rate (
  day TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  eur REAL NOT NULL CHECK (eur > 0),
  rate_day TEXT NOT NULL,
  PRIMARY KEY (day, currency)
) WITHOUT ROWID;
