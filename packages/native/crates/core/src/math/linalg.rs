//! Dense linear algebra for small symmetric positive-definite systems.
//!
//! The ridge normal equations are at most 18×18 (ADR-0006), so a hand-rolled
//! Cholesky is both the numerically correct choice for an SPD system and
//! faster than any general-purpose library call. Keeping it here means the
//! native crate has zero linear-algebra dependencies and compiles in seconds.
//!
//! Matrices are row-major: `a[i * n + j]` is row `i`, column `j`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinalgError {
    /// The matrix was not positive definite. With Tikhonov regularization
    /// (λ > 0) this should be unreachable, so it indicates NaN/Inf in the
    /// inputs rather than a genuinely singular system.
    NotPositiveDefinite,
    DimensionMismatch,
}

/// In-place Cholesky factorization: `a` becomes the lower-triangular `L` with
/// `L Lᵀ = A`. Only the lower triangle of `a` is read; the upper triangle is
/// zeroed on output so the result is unambiguous.
pub fn cholesky_factor(a: &mut [f64], n: usize) -> Result<(), LinalgError> {
    if a.len() != n * n {
        return Err(LinalgError::DimensionMismatch);
    }
    for j in 0..n {
        let mut diag = a[j * n + j];
        for k in 0..j {
            let ljk = a[j * n + k];
            diag -= ljk * ljk;
        }
        // Ordered so NaN is rejected explicitly rather than relying on a
        // negated comparison: `diag <= 0.0` is false for NaN, so the finiteness
        // check has to come first.
        if !diag.is_finite() || diag <= 0.0 {
            return Err(LinalgError::NotPositiveDefinite);
        }
        let ljj = diag.sqrt();
        a[j * n + j] = ljj;

        for i in (j + 1)..n {
            let mut sum = a[i * n + j];
            for k in 0..j {
                sum -= a[i * n + k] * a[j * n + k];
            }
            a[i * n + j] = sum / ljj;
        }
    }
    // Zero the upper triangle so `l` is unambiguously lower-triangular.
    for i in 0..n {
        for j in (i + 1)..n {
            a[i * n + j] = 0.0;
        }
    }
    Ok(())
}

/// Solve `L Lᵀ x = b` in place, given the Cholesky factor `l`.
pub fn cholesky_solve_in_place(l: &[f64], n: usize, b: &mut [f64]) -> Result<(), LinalgError> {
    if l.len() != n * n || b.len() != n {
        return Err(LinalgError::DimensionMismatch);
    }
    // Forward substitution: L y = b
    for i in 0..n {
        let mut sum = b[i];
        for k in 0..i {
            sum -= l[i * n + k] * b[k];
        }
        b[i] = sum / l[i * n + i];
    }
    // Back substitution: Lᵀ x = y
    for i in (0..n).rev() {
        let mut sum = b[i];
        for k in (i + 1)..n {
            sum -= l[k * n + i] * b[k];
        }
        b[i] = sum / l[i * n + i];
    }
    Ok(())
}

/// Solve `A x = b` for symmetric positive-definite `A`. `A` is not modified.
pub fn solve_spd(a: &[f64], n: usize, b: &[f64]) -> Result<Vec<f64>, LinalgError> {
    let mut l = a.to_vec();
    cholesky_factor(&mut l, n)?;
    let mut x = b.to_vec();
    cholesky_solve_in_place(&l, n, &mut x)?;
    Ok(x)
}

/// Invert a symmetric positive-definite matrix by solving `A X = I` column by
/// column. Only used for the GCV effective-degrees-of-freedom trace, which
/// needs the full inverse rather than a single solve.
pub fn invert_spd(a: &[f64], n: usize) -> Result<Vec<f64>, LinalgError> {
    let mut l = a.to_vec();
    cholesky_factor(&mut l, n)?;

    let mut inv = vec![0.0; n * n];
    let mut e = vec![0.0; n];
    for col in 0..n {
        e.iter_mut().for_each(|v| *v = 0.0);
        e[col] = 1.0;
        cholesky_solve_in_place(&l, n, &mut e)?;
        for row in 0..n {
            inv[row * n + col] = e[row];
        }
    }
    Ok(inv)
}

/// `tr(A B)` for two n×n matrices, without forming the product.
///
/// `tr(AB) = Σ_i Σ_j A_ij B_ji`.
pub fn trace_of_product(a: &[f64], b: &[f64], n: usize) -> f64 {
    let mut t = 0.0;
    for i in 0..n {
        for j in 0..n {
            t += a[i * n + j] * b[j * n + i];
        }
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64, tol: f64) -> bool {
        (a - b).abs() < tol
    }

    #[test]
    fn factors_known_matrix() {
        // A = [[4,2],[2,3]] → L = [[2,0],[1,sqrt(2)]]
        let mut a = vec![4.0, 2.0, 2.0, 3.0];
        cholesky_factor(&mut a, 2).unwrap();
        assert!(approx(a[0], 2.0, 1e-12));
        assert!(approx(a[1], 0.0, 1e-12));
        assert!(approx(a[2], 1.0, 1e-12));
        assert!(approx(a[3], 2.0_f64.sqrt(), 1e-12));
    }

    #[test]
    fn solves_spd_system() {
        // [[4,2],[2,3]] x = [10, 11] → x = [1, 3]
        let a = vec![4.0, 2.0, 2.0, 3.0];
        let x = solve_spd(&a, 2, &[10.0, 11.0]).unwrap();
        assert!(approx(x[0], 1.0, 1e-10), "x0 = {}", x[0]);
        assert!(approx(x[1], 3.0, 1e-10), "x1 = {}", x[1]);
    }

    #[test]
    fn rejects_non_positive_definite() {
        // Indefinite matrix.
        let mut a = vec![1.0, 2.0, 2.0, 1.0];
        assert_eq!(cholesky_factor(&mut a, 2), Err(LinalgError::NotPositiveDefinite));
    }

    #[test]
    fn rejects_nan_input() {
        let mut a = vec![f64::NAN, 0.0, 0.0, 1.0];
        assert_eq!(cholesky_factor(&mut a, 2), Err(LinalgError::NotPositiveDefinite));
    }

    #[test]
    fn inverse_times_original_is_identity() {
        let a = vec![4.0, 2.0, 1.0, 2.0, 5.0, 3.0, 1.0, 3.0, 6.0];
        let inv = invert_spd(&a, 3).unwrap();
        for i in 0..3 {
            for j in 0..3 {
                let mut s = 0.0;
                for k in 0..3 {
                    s += a[i * 3 + k] * inv[k * 3 + j];
                }
                let want = if i == j { 1.0 } else { 0.0 };
                assert!(approx(s, want, 1e-10), "({i},{j}) = {s}");
            }
        }
    }

    #[test]
    fn trace_of_product_matches_explicit_product() {
        let a = vec![1.0, 2.0, 3.0, 4.0];
        let b = vec![5.0, 6.0, 7.0, 8.0];
        // AB = [[1*5+2*7, 1*6+2*8],[3*5+4*7, 3*6+4*8]] = [[19,22],[43,50]] → tr = 69
        assert!(approx(trace_of_product(&a, &b, 2), 69.0, 1e-12));
    }

    #[test]
    fn solves_larger_random_spd_system() {
        // Build A = MᵀM + I, which is SPD by construction, and check we recover
        // a known solution.
        let n = 8;
        let mut m = vec![0.0; n * n];
        let mut seed = 12345u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / (1u64 << 31) as f64) - 0.5
        };
        for v in m.iter_mut() {
            *v = next();
        }
        let mut a = vec![0.0; n * n];
        for i in 0..n {
            for j in 0..n {
                let mut s = if i == j { 1.0 } else { 0.0 };
                for k in 0..n {
                    s += m[k * n + i] * m[k * n + j];
                }
                a[i * n + j] = s;
            }
        }
        let x_true: Vec<f64> = (0..n).map(|i| i as f64 * 0.5 - 1.0).collect();
        let b: Vec<f64> = (0..n)
            .map(|i| (0..n).map(|j| a[i * n + j] * x_true[j]).sum())
            .collect();
        let x = solve_spd(&a, n, &b).unwrap();
        for i in 0..n {
            assert!(approx(x[i], x_true[i], 1e-8), "x[{i}] = {} want {}", x[i], x_true[i]);
        }
    }
}
