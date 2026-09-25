//! A C-ABI wrapper around `batsat`, so the Numberlink encoding in `src/sat.ts`
//! can build and solve an instance without wasm-bindgen: the whole exported
//! surface is pointers into this module's own linear memory.
//!
//! Why not wasm-bindgen: it needs a post-processing CLI and generates import
//! bindings.  A bare `cdylib` exports `memory` and a handful of `extern "C"`
//! functions, which means `WebAssembly.instantiate(bytes, {})` works with an
//! empty import object — and that in turn means the module can be base64-inlined
//! into the single-file HTML build, where a `file://` page cannot fetch assets.
//!
//! Clause literals are ordinary DIMACS integers: `±1..±nvars`.

#![allow(static_mut_refs)]

use batsat::{BasicSolver, Lit, SolverInterface, Var, lbool};

/// Solver state.  Single-threaded wasm, so a mutable static is fine.
static mut SOLVER: Option<BasicSolver> = None;
/// Scratch space JS writes one clause into before calling `sat_add`.
static mut BUF: Vec<i32> = Vec::new();
/// Last model, as ±(var+1) — DIMACS literals, so JS can reuse its own indexing.
static mut MODEL: Vec<i32> = Vec::new();
/// Set when a clause made the instance trivially unsatisfiable.
static mut DEAD: bool = false;

pub const SAT: i32 = 10;
pub const UNSAT: i32 = 20;
pub const UNKNOWN: i32 = 0;

/// Fresh instance with `nvars` variables (numbered 1..nvars).
#[no_mangle]
pub extern "C" fn sat_reset(nvars: u32) {
    unsafe {
        let mut s = BasicSolver::default();
        for _ in 0..nvars {
            s.new_var_default();
        }
        MODEL.clear();
        DEAD = false;
        SOLVER = Some(s);
    }
}

/// Resize the scratch clause buffer and return a pointer to `len` i32 slots.
/// JS writes the literals there, then calls `sat_add`.
#[no_mangle]
pub extern "C" fn sat_buf(len: u32) -> *mut i32 {
    unsafe {
        if BUF.len() < len as usize {
            BUF.resize(len as usize, 0);
        }
        BUF.as_mut_ptr()
    }
}

/// Commit the first `len` slots of the scratch buffer as one clause.
/// Returns 0 if the instance became unsatisfiable at decision level 0.
#[no_mangle]
pub extern "C" fn sat_add(len: u32) -> i32 {
    unsafe {
        let Some(s) = SOLVER.as_mut() else { return 0 };
        if DEAD {
            return 0;
        }
        let mut lits: Vec<Lit> = Vec::with_capacity(len as usize);
        for i in 0..len as usize {
            let v = BUF[i];
            // batsat's `sign` means "positive": Lit::new(var, true) == +var.
            lits.push(Lit::new(Var::unsafe_from_idx(v.abs() as u32 - 1), v > 0));
        }
        if !s.add_clause_reuse(&mut lits) {
            DEAD = true;
        }
        if DEAD {
            0
        } else {
            1
        }
    }
}

/// Solve.  Returns 10 (SAT), 20 (UNSAT) or 0.
#[no_mangle]
pub extern "C" fn sat_solve() -> i32 {
    unsafe {
        let Some(s) = SOLVER.as_mut() else {
            return UNKNOWN;
        };
        if DEAD || !s.is_ok() {
            return UNSAT;
        }
        match s.solve_limited(&[]) {
            r if r == lbool::TRUE => {
                MODEL.clear();
                for (i, v) in s.get_model().iter().enumerate() {
                    // 1 = true, -1 = false, 0 = don't-care (a variable the
                    // search never had to decide).
                    let sign = if *v == lbool::TRUE {
                        1
                    } else if *v == lbool::FALSE {
                        -1
                    } else {
                        0
                    };
                    MODEL.push(sign * (i as i32 + 1));
                }
                SAT
            }
            r if r == lbool::FALSE => UNSAT,
            _ => UNKNOWN,
        }
    }
}

/// Pointer to the model array; valid until the next `sat_reset`/`sat_solve`.
#[no_mangle]
pub extern "C" fn sat_model_ptr() -> *const i32 {
    unsafe { MODEL.as_ptr() }
}

#[no_mangle]
pub extern "C" fn sat_model_len() -> u32 {
    unsafe { MODEL.len() as u32 }
}

/// Conflict count of the last solve — the only "nodes"-like figure a CDCL
/// solver reports, and the number worth showing next to the DFS node count.
#[no_mangle]
pub extern "C" fn sat_conflicts() -> u64 {
    unsafe {
        match SOLVER.as_ref() {
            Some(s) => s.num_conflicts(),
            None => 0,
        }
    }
}
