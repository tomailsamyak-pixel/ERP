// Indian GST for apparel: 5% if per-piece taxable value <= ₹2500, else 18%.
// Rate is applied to the price AFTER discount, per piece — this is the rule
// that trips people up, so it lives in one place.
//
// CGST+SGST when the sale is intra-state (customer state == shop state),
// IGST when inter-state.

function gstRateForPiece(taxableValuePerPiece) {
  return taxableValuePerPiece <= 2500 ? 5 : 18;
}

/**
 * Compute tax for one invoice line.
 * @param {number} mrp - MRP per unit
 * @param {number} qty
 * @param {number} lineDiscount - total discount applied to this line (all units)
 * @param {string} shopState - GST state code of the outlet
 * @param {string} customerState - GST state code of the customer (defaults to shopState)
 */
function taxLine({ mrp, qty, lineDiscount = 0, shopState, customerState }) {
  const gross = mrp * qty;
  const taxableTotal = Math.max(0, gross - lineDiscount);
  const perPiece = qty > 0 ? taxableTotal / qty : 0;
  const rate = gstRateForPiece(perPiece);

  const isInterState = customerState && customerState !== shopState;
  const taxAmount = round2((taxableTotal * rate) / 100);

  let cgst = 0, sgst = 0, igst = 0;
  if (isInterState) {
    igst = taxAmount;
  } else {
    cgst = round2(taxAmount / 2);
    sgst = round2(taxAmount - cgst); // avoid rounding drift
  }

  return {
    taxableValue: round2(taxableTotal),
    gstRate: rate,
    cgst, sgst, igst,
    lineTotal: round2(taxableTotal + cgst + sgst + igst),
  };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = { gstRateForPiece, taxLine, round2 };
