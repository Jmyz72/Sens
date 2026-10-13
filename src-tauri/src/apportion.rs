//! Largest-remainder apportionment. Spreads a reimbursement offset across the
//! lines of a split expense. Mirrored by `apportion` in `src/lib/reimbursements.ts`.

/// Split `total` across `weights` in proportion to each weight, in whole cents.
///
/// Every weight should be positive. `total` is clamped into `0..=sum(weights)`.
/// The result sums to the clamped total and `result[i] <= weights[i]`. Rounding
/// cents go to the largest fractional remainders; ties go to the earliest line.
pub fn apportion(total: i64, weights: &[i64]) -> Vec<i64> {
    let sum: i128 = weights.iter().map(|w| *w as i128).sum();
    if weights.is_empty() || sum <= 0 {
        return vec![0; weights.len()];
    }
    let t = (total as i128).clamp(0, sum);
    let mut shares: Vec<i64> = Vec::with_capacity(weights.len());
    let mut rems: Vec<(usize, i128)> = Vec::with_capacity(weights.len());
    for (i, w) in weights.iter().enumerate() {
        let num = t * (*w as i128);
        shares.push((num / sum) as i64);
        rems.push((i, num % sum));
    }
    let assigned: i64 = shares.iter().sum();
    let mut leftover = t as i64 - assigned;
    rems.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (i, _) in rems {
        if leftover <= 0 {
            break;
        }
        shares[i] += 1;
        leftover -= 1;
    }
    shares
}

#[cfg(test)]
mod tests {
    use super::apportion;

    #[test]
    fn splits_in_proportion() {
        assert_eq!(apportion(5_000, &[6_000, 4_000]), vec![3_000, 2_000]);
        assert_eq!(apportion(50, &[100]), vec![50]);
        assert_eq!(apportion(100, &[1, 99]), vec![1, 99]);
    }

    #[test]
    fn rounding_cents_follow_the_largest_remainder() {
        // Three 1-sen lines, 2-sen offset: no line goes past its own amount.
        assert_eq!(apportion(2, &[1, 1, 1]), vec![1, 1, 0]);
        assert_eq!(apportion(1, &[2, 2]), vec![1, 0]);
        assert_eq!(apportion(7, &[5, 3, 2]), vec![4, 2, 1]);
        // The larger remainder wins over the earlier line.
        assert_eq!(apportion(1, &[1, 2]), vec![0, 1]);
        // Remainders 6, 6, 8: the biggest goes first, then the tie goes to the earliest line.
        assert_eq!(apportion(2, &[3, 3, 4]), vec![1, 0, 1]);
    }

    #[test]
    fn handles_empty_zero_and_overshoot() {
        assert_eq!(apportion(5, &[]), Vec::<i64>::new());
        assert_eq!(apportion(0, &[3, 4]), vec![0, 0]);
        assert_eq!(apportion(99, &[2, 3]), vec![2, 3]);
        assert_eq!(apportion(-5, &[2, 3]), vec![0, 0]);
    }

    #[test]
    fn always_sums_to_the_total_and_never_exceeds_a_line() {
        for a in 1..=4i64 {
            for b in 1..=4i64 {
                for c in 1..=4i64 {
                    let w = [a, b, c];
                    let sum = a + b + c;
                    for total in 0..=sum {
                        let s = apportion(total, &w);
                        assert_eq!(s.iter().sum::<i64>(), total, "weights {w:?} total {total}");
                        for (share, weight) in s.iter().zip(w.iter()) {
                            assert!(share <= weight, "weights {w:?} total {total} got {s:?}");
                        }
                    }
                }
            }
        }
    }
}
