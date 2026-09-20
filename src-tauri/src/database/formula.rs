//! Small deterministic formula language for computed database fields.
//!
//! It is intentionally interpreted in Rust instead of being handed to
//! JavaScript or SQLite. The evaluator has bounded input and recursion, exact
//! decimal arithmetic, and no access to files, the network, or the clock.

#![allow(dead_code)]

use crate::database::format;
use rusqlite::{params, Transaction};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt;
use std::path::Path;

const MAX_TOKENS: usize = 4096;
const MAX_DEPTH: usize = 64;
const MAX_SCALE: u32 = 18;

type ProjectedValueRow = (
    String,
    Option<String>,
    Option<Vec<u8>>,
    Option<String>,
    Option<Vec<u8>>,
    Option<i64>,
    Option<String>,
    Option<i64>,
);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Decimal {
    coefficient: i128,
    scale: u32,
}

impl Decimal {
    pub fn parse(raw: &str) -> Result<Self, FormulaError> {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err(FormulaError::new("invalidNumber", "number is empty"));
        }
        let (negative, digits) = match raw.as_bytes().first() {
            Some(b'-') => (true, &raw[1..]),
            Some(b'+') => (false, &raw[1..]),
            _ => (false, raw),
        };
        let mut parts = digits.split('.');
        let whole = parts.next().unwrap_or_default();
        let fraction = parts.next().unwrap_or_default();
        if parts.next().is_some()
            || whole.is_empty() && fraction.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || !fraction.bytes().all(|byte| byte.is_ascii_digit())
            || fraction.len() > MAX_SCALE as usize
        {
            return Err(FormulaError::new(
                "invalidNumber",
                "number is not an exact decimal",
            ));
        }
        let scale = fraction.len() as u32;
        let digits = format!("{whole}{fraction}");
        let mut coefficient = digits
            .parse::<i128>()
            .map_err(|_| FormulaError::new("invalidNumber", "number is out of range"))?;
        if negative {
            coefficient = coefficient
                .checked_neg()
                .ok_or_else(|| FormulaError::new("invalidNumber", "number is out of range"))?;
        }
        Ok(Self::new(coefficient, scale))
    }

    pub fn from_i64(value: i64) -> Self {
        Self::new(value as i128, 0)
    }

    fn new(mut coefficient: i128, mut scale: u32) -> Self {
        while scale > 0 && coefficient % 10 == 0 {
            coefficient /= 10;
            scale -= 1;
        }
        Self { coefficient, scale }
    }

    fn align(&self, other: &Self) -> Result<(i128, i128, u32), FormulaError> {
        let scale = self.scale.max(other.scale);
        let left = self
            .coefficient
            .checked_mul(10_i128.pow(scale - self.scale))
            .ok_or_else(|| FormulaError::new("numberOverflow", "decimal operation overflowed"))?;
        let right = other
            .coefficient
            .checked_mul(10_i128.pow(scale - other.scale))
            .ok_or_else(|| FormulaError::new("numberOverflow", "decimal operation overflowed"))?;
        Ok((left, right, scale))
    }

    pub fn add(&self, other: &Self) -> Result<Self, FormulaError> {
        let (left, right, scale) = self.align(other)?;
        left.checked_add(right)
            .map(|value| Self::new(value, scale))
            .ok_or_else(|| FormulaError::new("numberOverflow", "decimal operation overflowed"))
    }

    pub fn sub(&self, other: &Self) -> Result<Self, FormulaError> {
        let (left, right, scale) = self.align(other)?;
        left.checked_sub(right)
            .map(|value| Self::new(value, scale))
            .ok_or_else(|| FormulaError::new("numberOverflow", "decimal operation overflowed"))
    }

    pub fn mul(&self, other: &Self) -> Result<Self, FormulaError> {
        let coefficient = self
            .coefficient
            .checked_mul(other.coefficient)
            .ok_or_else(|| FormulaError::new("numberOverflow", "decimal operation overflowed"))?;
        let scale = self.scale + other.scale;
        if scale > MAX_SCALE {
            return Err(FormulaError::new(
                "numberPrecision",
                "decimal result exceeds 18 fractional digits",
            ));
        }
        Ok(Self::new(coefficient, scale))
    }

    pub fn div(&self, other: &Self) -> Result<Self, FormulaError> {
        if other.coefficient == 0 {
            return Err(FormulaError::new("divisionByZero", "division by zero"));
        }
        // If the division is exact, normalize it before applying the output
        // scale. This avoids an unnecessary 10^36 intermediate for values
        // such as 1 / 0.000000000000000001.
        if self.coefficient % other.coefficient == 0 {
            let quotient = self.coefficient / other.coefficient;
            if other.scale >= self.scale {
                let coefficient = quotient
                    .checked_mul(10_i128.pow(other.scale - self.scale))
                    .ok_or_else(|| {
                        FormulaError::new("numberOverflow", "decimal operation overflowed")
                    })?;
                return Ok(Self::new(coefficient, 0));
            }
            return Ok(Self::new(quotient, self.scale - other.scale));
        }
        // (a / 10^self.scale) / (b / 10^other.scale), rounded toward zero
        // to MAX_SCALE fractional digits.
        let shift = MAX_SCALE
            .saturating_add(other.scale)
            .saturating_sub(self.scale);
        let numerator = self
            .coefficient
            .checked_mul(10_i128.pow(shift))
            .ok_or_else(|| FormulaError::new("numberOverflow", "decimal operation overflowed"))?;
        Ok(Self::new(numerator / other.coefficient, MAX_SCALE))
    }

    pub fn cmp(&self, other: &Self) -> Result<std::cmp::Ordering, FormulaError> {
        let (left, right, _) = self.align(other)?;
        Ok(left.cmp(&right))
    }
}

impl fmt::Display for Decimal {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.scale == 0 {
            return write!(formatter, "{}", self.coefficient);
        }
        let negative = self.coefficient < 0;
        let digits = self.coefficient.unsigned_abs().to_string();
        let scale = self.scale as usize;
        let (whole, fraction) = if digits.len() <= scale {
            (
                "0".to_owned(),
                format!("{}{}", "0".repeat(scale - digits.len()), digits),
            )
        } else {
            (
                digits[..digits.len() - scale].to_owned(),
                digits[digits.len() - scale..].to_owned(),
            )
        };
        write!(
            formatter,
            "{}{}.{}",
            if negative { "-" } else { "" },
            whole,
            fraction
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FormulaValue {
    Null,
    Boolean(bool),
    Number(Decimal),
    Text(String),
    Date(String),
}

impl FormulaValue {
    fn truthy(&self) -> Result<bool, FormulaError> {
        match self {
            Self::Boolean(value) => Ok(*value),
            Self::Null => Ok(false),
            _ => Err(FormulaError::new("typeMismatch", "expected a boolean")),
        }
    }

    fn is_empty(&self) -> bool {
        matches!(self, Self::Null) || matches!(self, Self::Text(value) if value.is_empty())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormulaError {
    pub code: String,
    pub message: String,
}

impl FormulaError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

impl fmt::Display for FormulaError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for FormulaError {}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Token {
    Number(String),
    Text(String),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Eq,
    NotEq,
    Less,
    LessEq,
    Greater,
    GreaterEq,
    And,
    Or,
    Not,
    LeftParen,
    RightParen,
    Comma,
    End,
}

fn tokenize(expression: &str) -> Result<Vec<Token>, FormulaError> {
    let mut result = Vec::new();
    let mut chars = expression.chars().peekable();
    while let Some(character) = chars.next() {
        if character.is_whitespace() {
            continue;
        }
        let token = match character {
            '+' => Token::Plus,
            '-' => Token::Minus,
            '*' => Token::Star,
            '/' => Token::Slash,
            '(' => Token::LeftParen,
            ')' => Token::RightParen,
            ',' => Token::Comma,
            '=' => {
                if chars.next_if_eq(&'=').is_some() {
                    Token::Eq
                } else {
                    return Err(FormulaError::new("parseError", "use == for equality"));
                }
            }
            '!' => {
                if chars.next_if_eq(&'=').is_some() {
                    Token::NotEq
                } else {
                    Token::Not
                }
            }
            '<' => {
                if chars.next_if_eq(&'=').is_some() {
                    Token::LessEq
                } else {
                    Token::Less
                }
            }
            '>' => {
                if chars.next_if_eq(&'=').is_some() {
                    Token::GreaterEq
                } else {
                    Token::Greater
                }
            }
            '&' => {
                if chars.next_if_eq(&'&').is_some() {
                    Token::And
                } else {
                    return Err(FormulaError::new("parseError", "use && for AND"));
                }
            }
            '|' => {
                if chars.next_if_eq(&'|').is_some() {
                    Token::Or
                } else {
                    return Err(FormulaError::new("parseError", "use || for OR"));
                }
            }
            '"' | '\'' => {
                let quote = character;
                let mut value = String::new();
                loop {
                    let Some(next) = chars.next() else {
                        return Err(FormulaError::new("parseError", "unterminated string"));
                    };
                    if next == quote {
                        break;
                    }
                    if next == '\\' {
                        let Some(escaped) = chars.next() else {
                            return Err(FormulaError::new("parseError", "unterminated escape"));
                        };
                        value.push(match escaped {
                            'n' => '\n',
                            'r' => '\r',
                            't' => '\t',
                            other => other,
                        });
                    } else {
                        value.push(next);
                    }
                    if value.len() > 1_000_000 {
                        return Err(FormulaError::new(
                            "inputTooLarge",
                            "string literal is too large",
                        ));
                    }
                }
                Token::Text(value)
            }
            character if character.is_ascii_digit() || character == '.' => {
                let mut value = character.to_string();
                while chars
                    .peek()
                    .is_some_and(|next| next.is_ascii_digit() || *next == '.')
                {
                    value.push(chars.next().unwrap());
                }
                Token::Number(value)
            }
            character if character.is_ascii_alphabetic() || character == '_' => {
                let mut value = character.to_string();
                while chars.peek().is_some_and(|next| {
                    next.is_ascii_alphanumeric() || *next == '_' || *next == '-'
                }) {
                    value.push(chars.next().unwrap());
                }
                match value.to_ascii_lowercase().as_str() {
                    "and" => Token::And,
                    "or" => Token::Or,
                    "not" => Token::Not,
                    _ => Token::Ident(value),
                }
            }
            _ => {
                return Err(FormulaError::new(
                    "parseError",
                    format!("unexpected character {character:?}"),
                ));
            }
        };
        result.push(token);
        if result.len() > MAX_TOKENS {
            return Err(FormulaError::new(
                "inputTooLarge",
                "formula has too many tokens",
            ));
        }
    }
    result.push(Token::End);
    Ok(result)
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Expr {
    Literal(FormulaValue),
    Reference(String),
    Unary(Token, Box<Expr>),
    Binary(Box<Expr>, Token, Box<Expr>),
    Call(String, Vec<Expr>),
}

struct Parser {
    tokens: Vec<Token>,
    position: usize,
}

impl Parser {
    fn parse(expression: &str) -> Result<Expr, FormulaError> {
        let mut parser = Self {
            tokens: tokenize(expression)?,
            position: 0,
        };
        let result = parser.parse_or(0)?;
        if !matches!(parser.peek(), Token::End) {
            return Err(FormulaError::new(
                "parseError",
                "unexpected token at end of formula",
            ));
        }
        Ok(result)
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.position]
    }

    fn next(&mut self) -> Token {
        let token = self.tokens[self.position].clone();
        self.position += 1;
        token
    }

    fn parse_or(&mut self, depth: usize) -> Result<Expr, FormulaError> {
        self.binary(depth, Self::parse_and, &[Token::Or])
    }

    fn parse_and(&mut self, depth: usize) -> Result<Expr, FormulaError> {
        self.binary(depth, Self::parse_compare, &[Token::And])
    }

    fn parse_compare(&mut self, depth: usize) -> Result<Expr, FormulaError> {
        self.binary(
            depth,
            Self::parse_sum,
            &[
                Token::Eq,
                Token::NotEq,
                Token::Less,
                Token::LessEq,
                Token::Greater,
                Token::GreaterEq,
            ],
        )
    }

    fn parse_sum(&mut self, depth: usize) -> Result<Expr, FormulaError> {
        self.binary(depth, Self::parse_product, &[Token::Plus, Token::Minus])
    }

    fn parse_product(&mut self, depth: usize) -> Result<Expr, FormulaError> {
        self.binary(depth, Self::parse_unary, &[Token::Star, Token::Slash])
    }

    fn binary<F>(
        &mut self,
        depth: usize,
        child: F,
        operators: &[Token],
    ) -> Result<Expr, FormulaError>
    where
        F: Fn(&mut Self, usize) -> Result<Expr, FormulaError>,
    {
        let mut left = child(self, depth + 1)?;
        while operators.iter().any(|operator| self.peek() == operator) {
            let operator = self.next();
            let right = child(self, depth + 1)?;
            left = Expr::Binary(Box::new(left), operator, Box::new(right));
        }
        Ok(left)
    }

    fn parse_unary(&mut self, depth: usize) -> Result<Expr, FormulaError> {
        if depth > MAX_DEPTH {
            return Err(FormulaError::new(
                "formulaTooDeep",
                "formula nesting is too deep",
            ));
        }
        if matches!(self.peek(), Token::Minus | Token::Not) {
            let operator = self.next();
            return Ok(Expr::Unary(
                operator,
                Box::new(self.parse_unary(depth + 1)?),
            ));
        }
        self.parse_primary(depth + 1)
    }

    fn parse_primary(&mut self, depth: usize) -> Result<Expr, FormulaError> {
        if depth > MAX_DEPTH {
            return Err(FormulaError::new(
                "formulaTooDeep",
                "formula nesting is too deep",
            ));
        }
        match self.next() {
            Token::Number(value) => {
                Ok(Expr::Literal(FormulaValue::Number(Decimal::parse(&value)?)))
            }
            Token::Text(value) => Ok(Expr::Literal(FormulaValue::Text(value))),
            Token::Ident(name) => match name.to_ascii_lowercase().as_str() {
                "true" => Ok(Expr::Literal(FormulaValue::Boolean(true))),
                "false" => Ok(Expr::Literal(FormulaValue::Boolean(false))),
                "null" => Ok(Expr::Literal(FormulaValue::Null)),
                _ if matches!(self.peek(), Token::LeftParen) => {
                    self.next();
                    let mut args = Vec::new();
                    if !matches!(self.peek(), Token::RightParen) {
                        loop {
                            args.push(self.parse_or(depth + 1)?);
                            if !matches!(self.peek(), Token::Comma) {
                                break;
                            }
                            self.next();
                        }
                    }
                    if !matches!(self.next(), Token::RightParen) {
                        return Err(FormulaError::new(
                            "parseError",
                            "missing closing parenthesis",
                        ));
                    }
                    Ok(Expr::Call(name, args))
                }
                _ => Ok(Expr::Reference(name)),
            },
            Token::LeftParen => {
                let result = self.parse_or(depth + 1)?;
                if !matches!(self.next(), Token::RightParen) {
                    return Err(FormulaError::new(
                        "parseError",
                        "missing closing parenthesis",
                    ));
                }
                Ok(result)
            }
            _ => Err(FormulaError::new("parseError", "expected a value")),
        }
    }
}

pub fn parse(expression: &str) -> Result<(), FormulaError> {
    Parser::parse(expression).map(|_| ())
}

pub fn evaluate(
    expression: &str,
    properties: &BTreeMap<String, FormulaValue>,
) -> Result<FormulaValue, FormulaError> {
    let ast = Parser::parse(expression)?;
    evaluate_expr(&ast, properties, 0)
}

pub fn extract_dependencies(expression: &str) -> Result<Vec<String>, FormulaError> {
    let ast = Parser::parse(expression)?;
    let mut out = Vec::new();
    extract_ast_references(&ast, &mut out);
    out.sort();
    out.dedup();
    Ok(out)
}

fn extract_ast_references(expr: &Expr, out: &mut Vec<String>) {
    match expr {
        Expr::Reference(name) => out.push(name.clone()),
        Expr::Unary(_, inner) => extract_ast_references(inner, out),
        Expr::Binary(left, _, right) => {
            extract_ast_references(left, out);
            extract_ast_references(right, out);
        }
        Expr::Call(_, args) => {
            for arg in args {
                extract_ast_references(arg, out);
            }
        }
        Expr::Literal(_) => {}
    }
}

fn evaluate_expr(
    expr: &Expr,
    properties: &BTreeMap<String, FormulaValue>,
    depth: usize,
) -> Result<FormulaValue, FormulaError> {
    if depth > MAX_DEPTH {
        return Err(FormulaError::new(
            "formulaTooDeep",
            "formula evaluation is too deep",
        ));
    }
    match expr {
        Expr::Literal(value) => Ok(value.clone()),
        Expr::Reference(name) => properties.get(name).cloned().ok_or_else(|| {
            FormulaError::new("missingProperty", format!("property {name} is missing"))
        }),
        Expr::Unary(operator, value) => {
            let value = evaluate_expr(value, properties, depth + 1)?;
            match (operator, value) {
                (Token::Minus, FormulaValue::Number(value)) => {
                    Ok(FormulaValue::Number(Decimal::from_i64(0).sub(&value)?))
                }
                (Token::Not, value) => Ok(FormulaValue::Boolean(!value.truthy()?)),
                _ => Err(FormulaError::new(
                    "typeMismatch",
                    "unary operator has an incompatible value",
                )),
            }
        }
        Expr::Binary(left, operator, right) => {
            let left = evaluate_expr(left, properties, depth + 1)?;
            if matches!(operator, Token::And) && left == FormulaValue::Boolean(false) {
                return Ok(FormulaValue::Boolean(false));
            }
            if matches!(operator, Token::Or) && left == FormulaValue::Boolean(true) {
                return Ok(FormulaValue::Boolean(true));
            }
            let right = evaluate_expr(right, properties, depth + 1)?;
            evaluate_binary(left, operator, right)
        }
        Expr::Call(name, args) => evaluate_call(name, args, properties, depth + 1),
    }
}

fn evaluate_binary(
    left: FormulaValue,
    operator: &Token,
    right: FormulaValue,
) -> Result<FormulaValue, FormulaError> {
    use std::cmp::Ordering;
    match operator {
        Token::And | Token::Or => Ok(FormulaValue::Boolean(if matches!(operator, Token::And) {
            left.truthy()? && right.truthy()?
        } else {
            left.truthy()? || right.truthy()?
        })),
        Token::Plus => match (left, right) {
            (FormulaValue::Number(a), FormulaValue::Number(b)) => {
                Ok(FormulaValue::Number(a.add(&b)?))
            }
            (FormulaValue::Text(a), FormulaValue::Text(b)) => {
                Ok(FormulaValue::Text(format!("{a}{b}")))
            }
            _ => Err(FormulaError::new(
                "typeMismatch",
                "plus expects two numbers or two strings",
            )),
        },
        Token::Minus | Token::Star | Token::Slash => match (left, right) {
            (FormulaValue::Number(a), FormulaValue::Number(b)) => {
                Ok(FormulaValue::Number(match operator {
                    Token::Minus => a.sub(&b)?,
                    Token::Star => a.mul(&b)?,
                    Token::Slash => a.div(&b)?,
                    _ => unreachable!(),
                }))
            }
            _ => Err(FormulaError::new(
                "typeMismatch",
                "arithmetic expects two numbers",
            )),
        },
        Token::Eq | Token::NotEq => {
            let equal = left == right;
            Ok(FormulaValue::Boolean(if matches!(operator, Token::Eq) {
                equal
            } else {
                !equal
            }))
        }
        Token::Less | Token::LessEq | Token::Greater | Token::GreaterEq => {
            let ordering = match (left, right) {
                (FormulaValue::Number(a), FormulaValue::Number(b)) => a.cmp(&b)?,
                (FormulaValue::Text(a), FormulaValue::Text(b))
                | (FormulaValue::Date(a), FormulaValue::Date(b)) => a.cmp(&b),
                _ => {
                    return Err(FormulaError::new(
                        "typeMismatch",
                        "comparison expects matching values",
                    ));
                }
            };
            Ok(FormulaValue::Boolean(match operator {
                Token::Less => ordering == Ordering::Less,
                Token::LessEq => ordering != Ordering::Greater,
                Token::Greater => ordering == Ordering::Greater,
                Token::GreaterEq => ordering != Ordering::Less,
                _ => unreachable!(),
            }))
        }
        _ => Err(FormulaError::new(
            "invalidOperator",
            "operator is not supported",
        )),
    }
}

fn evaluate_call(
    name: &str,
    args: &[Expr],
    properties: &BTreeMap<String, FormulaValue>,
    depth: usize,
) -> Result<FormulaValue, FormulaError> {
    let lowered = name.to_ascii_lowercase();
    match lowered.as_str() {
        "if" if args.len() == 3 => {
            if evaluate_expr(&args[0], properties, depth + 1)?.truthy()? {
                evaluate_expr(&args[1], properties, depth + 1)
            } else {
                evaluate_expr(&args[2], properties, depth + 1)
            }
        }
        "empty" if args.len() == 1 => Ok(FormulaValue::Boolean(
            evaluate_expr(&args[0], properties, depth + 1)?.is_empty(),
        )),
        "coalesce" if !args.is_empty() => {
            for arg in args {
                let value = evaluate_expr(arg, properties, depth + 1)?;
                if !value.is_empty() {
                    return Ok(value);
                }
            }
            Ok(FormulaValue::Null)
        }
        "contains" if args.len() == 2 => match (
            evaluate_expr(&args[0], properties, depth + 1)?,
            evaluate_expr(&args[1], properties, depth + 1)?,
        ) {
            (FormulaValue::Text(haystack), FormulaValue::Text(needle)) => {
                Ok(FormulaValue::Boolean(haystack.contains(&needle)))
            }
            _ => Err(FormulaError::new(
                "typeMismatch",
                "contains expects two strings",
            )),
        },
        "lower" | "upper" if args.len() == 1 => {
            match evaluate_expr(&args[0], properties, depth + 1)? {
                FormulaValue::Text(value) => Ok(FormulaValue::Text(if lowered == "lower" {
                    value.to_lowercase()
                } else {
                    value.to_uppercase()
                })),
                _ => Err(FormulaError::new(
                    "typeMismatch",
                    "string function expects text",
                )),
            }
        }
        "length" if args.len() == 1 => match evaluate_expr(&args[0], properties, depth + 1)? {
            FormulaValue::Text(value) => Ok(FormulaValue::Number(Decimal::from_i64(
                value.chars().count() as i64,
            ))),
            _ => Err(FormulaError::new("typeMismatch", "length expects text")),
        },
        _ => Err(FormulaError::new(
            "unknownFunction",
            format!("function {name} is not supported or has the wrong number of arguments"),
        )),
    }
}

pub fn topological_formula_order<'a>(
    formulas: &[(&'a str, &'a str)],
) -> Result<Vec<&'a str>, FormulaError> {
    let mut graph: HashMap<&'a str, Vec<&'a str>> = HashMap::new();
    let mut in_degree: HashMap<&'a str, usize> = HashMap::new();
    let mut formula_ids: HashSet<&'a str> = HashSet::new();

    for &(id, _) in formulas {
        formula_ids.insert(id);
        graph.entry(id).or_default();
        in_degree.entry(id).or_insert(0);
    }

    for &(id, expr) in formulas {
        let deps = extract_dependencies(expr)?;
        for dep in deps {
            if let Some(&dep_id) = formula_ids.get(dep.as_str()) {
                if dep_id != id {
                    graph.entry(dep_id).or_default().push(id);
                    *in_degree.entry(id).or_insert(0) += 1;
                } else {
                    return Err(FormulaError::new(
                        "cycleDetected",
                        format!("self-referencing cycle detected in formula {id}"),
                    ));
                }
            }
        }
    }

    let mut queue = VecDeque::new();
    for &(id, _) in formulas {
        if in_degree.get(id).copied().unwrap_or(0) == 0 {
            queue.push_back(id);
        }
    }

    let mut order = Vec::new();
    while let Some(node) = queue.pop_front() {
        order.push(node);
        if let Some(dependents) = graph.get(node) {
            for &dependent in dependents {
                if let Some(deg) = in_degree.get_mut(dependent) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(dependent);
                    }
                }
            }
        }
    }

    if order.len() != formulas.len() {
        return Err(FormulaError::new(
            "cycleDetected",
            "cycle detected in formula dependencies",
        ));
    }

    Ok(order)
}

pub fn compute_formulas_for_notes(
    tx: &Transaction<'_>,
    database_id: &str,
    note_ids: &[String],
    manifest: &format::DatabaseManifest,
) -> Result<(), String> {
    let mut formulas = Vec::new();
    for prop in &manifest.properties {
        if let format::PropertyDefinition::Formula(fields) = prop {
            formulas.push((fields.id.as_str(), fields.config.expression.as_str()));
        }
    }
    if formulas.is_empty() || note_ids.is_empty() {
        return Ok(());
    }

    let order = match topological_formula_order(&formulas) {
        Ok(order) => order,
        Err(err) => return Err(format!("{}: {}", err.code, err.message)),
    };

    let mut name_to_id = HashMap::new();
    for prop in &manifest.properties {
        if let Some(id) = prop.id() {
            let name = match prop {
                format::PropertyDefinition::Text(f) => &f.name,
                format::PropertyDefinition::Number(f) => &f.name,
                format::PropertyDefinition::Checkbox(f) => &f.name,
                format::PropertyDefinition::Date(f) => &f.name,
                format::PropertyDefinition::Select(f) => &f.name,
                format::PropertyDefinition::MultiSelect(f) => &f.name,
                format::PropertyDefinition::Status(f) => &f.name,
                format::PropertyDefinition::Url(f) => &f.name,
                format::PropertyDefinition::Files(f) => &f.name,
                format::PropertyDefinition::Relation(f) => &f.name,
                format::PropertyDefinition::Formula(f) => &f.name,
                format::PropertyDefinition::Rollup(f) => &f.name,
                _ => continue,
            };
            name_to_id.insert(name.clone(), id.to_owned());
        }
    }

    let formula_map: HashMap<&str, &str> = formulas.into_iter().collect();

    for note_id in note_ids {
        for &formula_id in &order {
            let expression = formula_map.get(formula_id).unwrap_or(&"");
            if expression.is_empty() {
                continue;
            }

            let mut prop_values = BTreeMap::new();
            {
                let mut stmt = tx
                    .prepare_cached(
                        "SELECT property_id, value_type, text_value, decimal_value, bool_value, date_start FROM db_values WHERE database_id = ?1 AND note_id = ?2",
                    )
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt
                    .query(params![database_id, note_id])
                    .map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let pid: String = row.get(0).map_err(|e| e.to_string())?;
                    let vtype: String = row.get(1).map_err(|e| e.to_string())?;
                    let tval: Option<String> = row.get(2).map_err(|e| e.to_string())?;
                    let dval: Option<String> = row.get(3).map_err(|e| e.to_string())?;
                    let bval: Option<i64> = row.get(4).map_err(|e| e.to_string())?;
                    let date_val: Option<String> = row.get(5).map_err(|e| e.to_string())?;

                    let fval = match vtype.as_str() {
                        "number" => dval
                            .as_deref()
                            .and_then(|d| Decimal::parse(d).ok())
                            .map(FormulaValue::Number)
                            .unwrap_or(FormulaValue::Null),
                        "checkbox" => FormulaValue::Boolean(bval.unwrap_or(0) != 0),
                        "date" => date_val
                            .map(FormulaValue::Date)
                            .unwrap_or(FormulaValue::Null),
                        "formula" | "rollup" => {
                            if let Some(ref d) = dval {
                                Decimal::parse(d)
                                    .map(FormulaValue::Number)
                                    .unwrap_or(FormulaValue::Null)
                            } else if let Some(b) = bval {
                                FormulaValue::Boolean(b != 0)
                            } else if let Some(dt) = date_val {
                                FormulaValue::Date(dt)
                            } else if let Some(t) = tval {
                                FormulaValue::Text(t)
                            } else {
                                FormulaValue::Null
                            }
                        }
                        _ => tval.map(FormulaValue::Text).unwrap_or(FormulaValue::Null),
                    };
                    prop_values.insert(pid, fval);
                }
            }

            for (name, id) in &name_to_id {
                if let Some(val) = prop_values.get(id).cloned() {
                    prop_values.insert(name.clone(), val);
                }
            }

            if let Ok(result) = evaluate(expression, &prop_values) {
                let (
                    canonical_json,
                    text_val,
                    text_key,
                    dec_val,
                    dec_key,
                    bool_val,
                    d_start,
                    d_start_key,
                ): ProjectedValueRow = match &result {
                    FormulaValue::Number(d) => {
                        let dec_str = d.to_string();
                        let key = super::projection::decimal_sort_key(&dec_str);
                        (
                            serde_json::json!({ "type": "number", "decimal": dec_str }).to_string(),
                            None,
                            None,
                            Some(dec_str),
                            key,
                            None,
                            None,
                            None,
                        )
                    }
                    FormulaValue::Text(s) => {
                        let key = Some(s.to_lowercase().into_bytes());
                        (
                            serde_json::json!({ "type": "text", "value": s }).to_string(),
                            Some(s.clone()),
                            key,
                            None,
                            None,
                            None,
                            None,
                            None,
                        )
                    }
                    FormulaValue::Boolean(b) => (
                        serde_json::json!({ "type": "checkbox", "checked": b }).to_string(),
                        None,
                        None,
                        None,
                        None,
                        Some(*b as i64),
                        None,
                        None,
                    ),
                    FormulaValue::Date(d) => {
                        let (key, _) = super::projection::date_key(d);
                        (
                            serde_json::json!({ "type": "date", "start": d }).to_string(),
                            None,
                            None,
                            None,
                            None,
                            None,
                            Some(d.clone()),
                            key,
                        )
                    }
                    FormulaValue::Null => (
                        serde_json::json!({ "type": "null" }).to_string(),
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    ),
                };

                tx.execute(
                    "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, text_value, text_sort_key, decimal_value, decimal_sort_key, bool_value, date_start, date_start_key, source_revision)
                     VALUES (?1, ?2, ?3, 'formula', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'formula')
                     ON CONFLICT(database_id, note_id, property_id) DO UPDATE SET
                        value_type = 'formula',
                        canonical_json = excluded.canonical_json,
                        text_value = excluded.text_value,
                        text_sort_key = excluded.text_sort_key,
                        decimal_value = excluded.decimal_value,
                        decimal_sort_key = excluded.decimal_sort_key,
                        bool_value = excluded.bool_value,
                        date_start = excluded.date_start,
                        date_start_key = excluded.date_start_key,
                        source_revision = 'formula'",
                    params![
                        database_id,
                        note_id,
                        formula_id,
                        canonical_json,
                        text_val,
                        text_key,
                        dec_val,
                        dec_key,
                        bool_val,
                        d_start,
                        d_start_key,
                    ],
                )
                .map_err(|e| e.to_string())?;
            }
        }
    }

    Ok(())
}

pub fn compute_rollups_for_notes(
    tx: &Transaction<'_>,
    database_id: &str,
    note_ids: &[String],
    manifest: &format::DatabaseManifest,
) -> Result<(), String> {
    let mut rollups = Vec::new();
    for prop in &manifest.properties {
        if let format::PropertyDefinition::Rollup(fields) = prop {
            rollups.push((
                fields.id.as_str(),
                fields.config.relation_property_id.as_str(),
                fields.config.target_property_id.as_str(),
                fields.config.aggregation.as_str(),
            ));
        }
    }
    if rollups.is_empty() || note_ids.is_empty() {
        return Ok(());
    }

    for note_id in note_ids {
        for &(rollup_id, rel_id, target_prop_id, aggregation) in &rollups {
            let mut target_note_ids = Vec::new();
            {
                let mut stmt = tx
                    .prepare_cached(
                        "SELECT target_note_id FROM db_relation_edges WHERE source_database_id = ?1 AND source_note_id = ?2 AND property_id = ?3 ORDER BY position",
                    )
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt
                    .query(params![database_id, note_id, rel_id])
                    .map_err(|e| e.to_string())?;
                while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let tid: String = row.get(0).map_err(|e| e.to_string())?;
                    target_note_ids.push(tid);
                }
            }

            let mut target_values = Vec::new();
            for tid in &target_note_ids {
                let mut stmt = tx
                    .prepare_cached(
                        "SELECT value_type, text_value, decimal_value, bool_value, date_start FROM db_values WHERE note_id = ?1 AND property_id = ?2",
                    )
                    .map_err(|e| e.to_string())?;
                let mut rows = stmt
                    .query(params![tid, target_prop_id])
                    .map_err(|e| e.to_string())?;
                if let Some(row) = rows.next().map_err(|e| e.to_string())? {
                    let vtype: String = row.get(0).map_err(|e| e.to_string())?;
                    let tval: Option<String> = row.get(1).map_err(|e| e.to_string())?;
                    let dval: Option<String> = row.get(2).map_err(|e| e.to_string())?;
                    let bval: Option<i64> = row.get(3).map_err(|e| e.to_string())?;
                    let dtval: Option<String> = row.get(4).map_err(|e| e.to_string())?;
                    target_values.push((vtype, tval, dval, bval, dtval));
                }
            }

            let (
                canonical_json,
                text_val,
                text_key,
                dec_val,
                dec_key,
                bool_val,
                d_start,
                d_start_key,
            ): ProjectedValueRow = match aggregation {
                "count" => {
                    let count = target_values.len() as i64;
                    let dec_str = count.to_string();
                    let key = super::projection::decimal_sort_key(&dec_str);
                    (
                        serde_json::json!({ "type": "number", "decimal": dec_str }).to_string(),
                        None,
                        None,
                        Some(dec_str),
                        key,
                        None,
                        None,
                        None,
                    )
                }
                "countUnique" => {
                    let mut unique = HashSet::new();
                    for (_, t, d, b, dt) in &target_values {
                        let repr = if let Some(d) = d {
                            d.clone()
                        } else if let Some(t) = t {
                            t.clone()
                        } else if let Some(b) = b {
                            b.to_string()
                        } else if let Some(dt) = dt {
                            dt.clone()
                        } else {
                            continue;
                        };
                        unique.insert(repr);
                    }
                    let count = unique.len() as i64;
                    let dec_str = count.to_string();
                    let key = super::projection::decimal_sort_key(&dec_str);
                    (
                        serde_json::json!({ "type": "number", "decimal": dec_str }).to_string(),
                        None,
                        None,
                        Some(dec_str),
                        key,
                        None,
                        None,
                        None,
                    )
                }
                "sum" | "avg" => {
                    let mut sum = Decimal::from_i64(0);
                    let mut count = 0;
                    for (_, _, d, _, _) in &target_values {
                        if let Some(d_str) = d {
                            if let Ok(parsed) = Decimal::parse(d_str) {
                                if let Ok(s) = sum.add(&parsed) {
                                    sum = s;
                                    count += 1;
                                }
                            }
                        }
                    }
                    if aggregation == "avg" && count > 0 {
                        let avg = sum.div(&Decimal::from_i64(count)).unwrap_or(sum);
                        let dec_str = avg.to_string();
                        let key = super::projection::decimal_sort_key(&dec_str);
                        (
                            serde_json::json!({ "type": "number", "decimal": dec_str }).to_string(),
                            None,
                            None,
                            Some(dec_str),
                            key,
                            None,
                            None,
                            None,
                        )
                    } else {
                        let dec_str = sum.to_string();
                        let key = super::projection::decimal_sort_key(&dec_str);
                        (
                            serde_json::json!({ "type": "number", "decimal": dec_str }).to_string(),
                            None,
                            None,
                            Some(dec_str),
                            key,
                            None,
                            None,
                            None,
                        )
                    }
                }
                "min" | "max" => {
                    let is_max = aggregation == "max";
                    let mut best_dec: Option<Decimal> = None;
                    for (_, _, d, _, _) in &target_values {
                        if let Some(d_str) = d {
                            if let Ok(parsed) = Decimal::parse(d_str) {
                                match &best_dec {
                                    None => best_dec = Some(parsed),
                                    Some(curr) => {
                                        if let Ok(ord) = parsed.cmp(curr) {
                                            if (is_max && ord == std::cmp::Ordering::Greater)
                                                || (!is_max && ord == std::cmp::Ordering::Less)
                                            {
                                                best_dec = Some(parsed);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    if let Some(d) = best_dec {
                        let dec_str = d.to_string();
                        let key = super::projection::decimal_sort_key(&dec_str);
                        (
                            serde_json::json!({ "type": "number", "decimal": dec_str }).to_string(),
                            None,
                            None,
                            Some(dec_str),
                            key,
                            None,
                            None,
                            None,
                        )
                    } else {
                        (
                            serde_json::json!({ "type": "null" }).to_string(),
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                            None,
                        )
                    }
                }
                _ => (
                    serde_json::json!({ "type": "null" }).to_string(),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                ),
            };

            tx.execute(
                "INSERT INTO db_values (database_id, note_id, property_id, value_type, canonical_json, text_value, text_sort_key, decimal_value, decimal_sort_key, bool_value, date_start, date_start_key, source_revision)
                 VALUES (?1, ?2, ?3, 'rollup', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'rollup')
                 ON CONFLICT(database_id, note_id, property_id) DO UPDATE SET
                    value_type = 'rollup',
                    canonical_json = excluded.canonical_json,
                    text_value = excluded.text_value,
                    text_sort_key = excluded.text_sort_key,
                    decimal_value = excluded.decimal_value,
                    decimal_sort_key = excluded.decimal_sort_key,
                    bool_value = excluded.bool_value,
                    date_start = excluded.date_start,
                    date_start_key = excluded.date_start_key,
                    source_revision = 'rollup'",
                params![
                    database_id,
                    note_id,
                    rollup_id,
                    canonical_json,
                    text_val,
                    text_key,
                    dec_val,
                    dec_key,
                    bool_val,
                    d_start,
                    d_start_key,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

pub fn refresh_dependent_rollups(
    tx: &Transaction<'_>,
    vault: &Path,
    target_note_ids: &[String],
) -> Result<(), String> {
    let mut sources_by_db: HashMap<String, HashSet<String>> = HashMap::new();
    let mut stmt = tx
        .prepare_cached(
            "SELECT DISTINCT source_database_id, source_note_id FROM db_relation_edges WHERE target_note_id = ?1",
        )
        .map_err(|e| e.to_string())?;

    for tid in target_note_ids {
        let mut rows = stmt.query(params![tid]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let s_db: String = row.get(0).map_err(|e| e.to_string())?;
            let s_note: String = row.get(1).map_err(|e| e.to_string())?;
            sources_by_db.entry(s_db).or_default().insert(s_note);
        }
    }

    for (s_db, s_notes) in sources_by_db {
        let container_path: Result<String, _> = tx.query_row(
            "SELECT container_path FROM db_databases WHERE database_id = ?1",
            [&s_db],
            |row| row.get(0),
        );
        if let Ok(c_path) = container_path {
            if let Ok(container) = crate::paths::confine(vault, &vault.join(&c_path)) {
                let m_path = super::discovery::manifest_path_for_container(&container);
                if let Ok(bytes) = std::fs::read(&m_path) {
                    if let Ok(parsed) = crate::database::format::parse_manifest(&bytes) {
                        let note_vec: Vec<String> = s_notes.into_iter().collect();
                        let _ = compute_rollups_for_notes(tx, &s_db, &note_vec, &parsed.value);
                    }
                }
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn decimal_operations_are_exact_and_division_is_bounded() {
        let mut values = BTreeMap::new();
        values.insert(
            "a".to_owned(),
            FormulaValue::Number(Decimal::parse("0.1").unwrap()),
        );
        values.insert(
            "b".to_owned(),
            FormulaValue::Number(Decimal::parse("0.2").unwrap()),
        );
        assert_eq!(
            evaluate("a + b == 0.3", &values).unwrap(),
            FormulaValue::Boolean(true)
        );
        assert_eq!(
            evaluate("1 / 0.000000000000000001", &values).unwrap(),
            FormulaValue::Number(Decimal::parse("1000000000000000000").unwrap())
        );
        assert_eq!(
            evaluate("1 / 8", &BTreeMap::new()).unwrap(),
            FormulaValue::Number(Decimal::parse("0.125").unwrap())
        );
        assert_eq!(
            evaluate("1 / 0", &BTreeMap::new()).unwrap_err().code,
            "divisionByZero"
        );
    }

    #[test]
    fn functions_and_missing_property_are_typed() {
        let mut values = BTreeMap::new();
        values.insert("name".to_owned(), FormulaValue::Text("Alex".to_owned()));
        assert_eq!(
            evaluate("if(contains(name, \"A\"), \"yes\", \"no\")", &values).unwrap(),
            FormulaValue::Text("yes".to_owned())
        );
        assert_eq!(
            evaluate("missing + 1", &values).unwrap_err().code,
            "missingProperty"
        );
    }

    #[test]
    fn parser_rejects_unsupported_access_and_unbounded_input() {
        assert_eq!(parse("foo.bar").unwrap_err().code, "parseError");
        assert_eq!(
            parse(&"1 + ".repeat(5000)).unwrap_err().code,
            "inputTooLarge"
        );
    }

    #[test]
    fn st10_formula_dependency_graph_and_cycle_detection() {
        // Linear dependencies: c depends on b, b depends on a
        let formulas = [
            ("prop_c", "prop_b + 1"),
            ("prop_a", "10"),
            ("prop_b", "prop_a * 2"),
        ];
        let order = topological_formula_order(&formulas).unwrap();
        assert_eq!(order, vec!["prop_a", "prop_b", "prop_c"]);

        // Mutual cycle: x depends on y, y depends on x
        let cyclic = [("prop_x", "prop_y + 1"), ("prop_y", "prop_x + 1")];
        let err = topological_formula_order(&cyclic).unwrap_err();
        assert_eq!(err.code, "cycleDetected");

        // Self cycle: z depends on z
        let self_cycle = [("prop_z", "prop_z + 1")];
        let err = topological_formula_order(&self_cycle).unwrap_err();
        assert_eq!(err.code, "cycleDetected");
    }

    #[test]
    fn st10_formula_evaluation_and_storage() {
        use crate::index::schema::init_schema;
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        let db_id = "01J00000000000000000000000";
        let note_id = "01J00000000000000000000001";
        conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            params![db_id],
        ).unwrap();

        conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, 'note.md', 'Note', 0, 0, '', 0, 0, 0)",
            params![note_id],
        ).unwrap();
        for (pid, ptype) in [("price", "number"), ("tax", "number"), ("total", "formula")] {
            conn.execute(
                "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
                params![db_id, pid, ptype],
            ).unwrap();
        }

        // Insert input values: price = 100, tax = 20
        conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'price', 'number', '100', '{\"type\":\"number\",\"decimal\":\"100\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'tax', 'number', '20', '{\"type\":\"number\",\"decimal\":\"20\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();

        let manifest = format::DatabaseManifest {
            database_id: db_id.to_owned(),
            name: "Database".to_owned(),
            icon: None,
            cover: None,
            locked: false,
            membership: format::Membership {
                kind: "folder".to_owned(),
                recursive: false,
                extra: Default::default(),
            },
            properties: vec![
                format::PropertyDefinition::Number(format::PropertyFields {
                    id: "price".to_owned(),
                    name: "Price".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::NumberConfig {
                        format: "number".to_owned(),
                        currency: None,
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
                format::PropertyDefinition::Number(format::PropertyFields {
                    id: "tax".to_owned(),
                    name: "Tax".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::NumberConfig {
                        format: "number".to_owned(),
                        currency: None,
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
                format::PropertyDefinition::Formula(format::PropertyFields {
                    id: "total".to_owned(),
                    name: "Total".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::FormulaConfig {
                        version: 1,
                        expression: "price + tax".to_owned(),
                        result_type: Some("number".to_owned()),
                        dependencies: vec!["price".to_owned(), "tax".to_owned()],
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
            ],
            views: Vec::new(),
            view_order: Vec::new(),
            default_view_id: None,
            template_order: Vec::new(),
            default_template_id: None,
            format: "amby-database".to_owned(),
            format_version: 1,
            extra: Default::default(),
        };

        let tx = conn.transaction().unwrap();
        compute_formulas_for_notes(&tx, db_id, &[note_id.to_owned()], &manifest).unwrap();
        tx.commit().unwrap();

        let (val_type, dec_val): (String, String) = conn.query_row(
            "SELECT value_type, decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'total'",
            params![db_id, note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();

        assert_eq!(val_type, "formula");
        assert_eq!(dec_val, "120");
    }

    #[test]
    fn st10_rollup_computation_over_relations() {
        use crate::index::schema::init_schema;
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        let db_id = "01J00000000000000000000000";
        let project_id = "01J00000000000000000000001";
        let task1_id = "01J00000000000000000000002";
        let task2_id = "01J00000000000000000000003";

        conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            params![db_id],
        ).unwrap();

        for (nid, title) in [
            (project_id, "Project"),
            (task1_id, "Task 1"),
            (task2_id, "Task 2"),
        ] {
            conn.execute(
                "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, ?2, ?3, 0, 0, '', 0, 0, 0)",
                params![nid, format!("{title}.md"), title],
            ).unwrap();
        }
        for (pid, ptype) in [
            ("tasks", "relation"),
            ("hours", "number"),
            ("total_hours", "rollup"),
            ("task_count", "rollup"),
        ] {
            conn.execute(
                "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
                params![db_id, pid, ptype],
            ).unwrap();
        }

        // Tasks have hours
        conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'hours', 'number', '10', '{\"type\":\"number\",\"decimal\":\"10\"}', 'rec')",
            params![db_id, task1_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, 'hours', 'number', '25', '{\"type\":\"number\",\"decimal\":\"25\"}', 'rec')",
            params![db_id, task2_id],
        ).unwrap();

        // Project links to Task1 and Task2
        conn.execute(
            "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES (?1, ?2, 'tasks', ?3, 0, 'resolved')",
            params![db_id, project_id, task1_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO db_relation_edges (source_database_id, source_note_id, property_id, target_note_id, position, target_state) VALUES (?1, ?2, 'tasks', ?3, 1, 'resolved')",
            params![db_id, project_id, task2_id],
        ).unwrap();

        let manifest = format::DatabaseManifest {
            database_id: db_id.to_owned(),
            name: "Database".to_owned(),
            icon: None,
            cover: None,
            locked: false,
            membership: format::Membership {
                kind: "folder".to_owned(),
                recursive: false,
                extra: Default::default(),
            },
            properties: vec![
                format::PropertyDefinition::Relation(format::PropertyFields {
                    id: "tasks".to_owned(),
                    name: "Tasks".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::RelationConfig {
                        target_database_id: db_id.to_owned(),
                        max_items: None,
                        inverse_property_id: None,
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
                format::PropertyDefinition::Rollup(format::PropertyFields {
                    id: "total_hours".to_owned(),
                    name: "Total Hours".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::RollupConfig {
                        relation_property_id: "tasks".to_owned(),
                        target_property_id: "hours".to_owned(),
                        aggregation: "sum".to_owned(),
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
                format::PropertyDefinition::Rollup(format::PropertyFields {
                    id: "task_count".to_owned(),
                    name: "Task Count".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::RollupConfig {
                        relation_property_id: "tasks".to_owned(),
                        target_property_id: "hours".to_owned(),
                        aggregation: "count".to_owned(),
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
            ],
            views: Vec::new(),
            view_order: Vec::new(),
            default_view_id: None,
            template_order: Vec::new(),
            default_template_id: None,
            format: "amby-database".to_owned(),
            format_version: 1,
            extra: Default::default(),
        };

        let tx = conn.transaction().unwrap();
        compute_rollups_for_notes(&tx, db_id, &[project_id.to_owned()], &manifest).unwrap();
        tx.commit().unwrap();

        let (sum_type, sum_val): (String, String) = conn.query_row(
            "SELECT value_type, decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'total_hours'",
            params![db_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(sum_type, "rollup");
        assert_eq!(sum_val, "35");

        let (cnt_type, cnt_val): (String, String) = conn.query_row(
            "SELECT value_type, decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = 'task_count'",
            params![db_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(cnt_type, "rollup");
        assert_eq!(cnt_val, "2");
    }
    #[test]
    fn review_numeric_formula_chain() {
        use crate::index::schema::init_schema;
        let mut conn = Connection::open_in_memory().unwrap();
        init_schema(&conn).unwrap();

        let db_id = "01J00000000000000000000000";
        let note_id = "01J00000000000000000000001";
        conn.execute(
            "INSERT INTO db_databases (database_id, container_path, name, locked, format_version, manifest_revision, projection_state) VALUES (?1, 'Database', 'Database', 0, 1, 'manifest', 'healthy')",
            params![db_id],
        ).unwrap();

        conn.execute(
            "INSERT INTO notes (id, path, title, mtime, size, content, word_count, created_at, updated_at) VALUES (?1, 'note.md', 'Note', 0, 0, '', 0, 0, 0)",
            params![note_id],
        ).unwrap();
        for (pid, ptype) in [
            ("01J00000000000000000000011", "number"),
            ("01J00000000000000000000012", "number"),
            ("01J00000000000000000000013", "formula"),
        ] {
            conn.execute(
                "INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, ?2, 0, ?2, ?3, 'alwaysShow', '{}')",
                params![db_id, pid, ptype],
            ).unwrap();
        }

        // Insert input values: price = 100, tax = 20
        conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, '01J00000000000000000000011', 'number', '100', '{\"type\":\"number\",\"decimal\":\"100\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();
        conn.execute(
            "INSERT INTO db_values (database_id, note_id, property_id, value_type, decimal_value, canonical_json, source_revision) VALUES (?1, ?2, '01J00000000000000000000012', 'number', '20', '{\"type\":\"number\",\"decimal\":\"20\"}', 'rec')",
            params![db_id, note_id],
        ).unwrap();

        let mut manifest = format::DatabaseManifest {
            database_id: db_id.to_owned(),
            name: "Database".to_owned(),
            icon: None,
            cover: None,
            locked: false,
            membership: format::Membership {
                kind: "folder".to_owned(),
                recursive: false,
                extra: Default::default(),
            },
            properties: vec![
                format::PropertyDefinition::Number(format::PropertyFields {
                    id: "01J00000000000000000000011".to_owned(),
                    name: "Price".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::NumberConfig {
                        format: "number".to_owned(),
                        currency: None,
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
                format::PropertyDefinition::Number(format::PropertyFields {
                    id: "01J00000000000000000000012".to_owned(),
                    name: "Tax".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::NumberConfig {
                        format: "number".to_owned(),
                        currency: None,
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
                format::PropertyDefinition::Formula(format::PropertyFields {
                    id: "01J00000000000000000000013".to_owned(),
                    name: "Total".to_owned(),
                    page_visibility: "alwaysShow".to_owned(),
                    config: format::FormulaConfig {
                        version: 1,
                        expression: "Price + Tax".to_owned(),
                        result_type: Some("number".to_owned()),
                        dependencies: vec![
                            "01J00000000000000000000011".to_owned(),
                            "01J00000000000000000000012".to_owned(),
                        ],
                        extra: Default::default(),
                    },
                    yaml_binding: None,
                    extra: Default::default(),
                }),
            ],
            views: Vec::new(),
            view_order: Vec::new(),
            default_view_id: None,
            template_order: Vec::new(),
            default_template_id: None,
            format: "amby-database".to_owned(),
            format_version: 1,
            extra: Default::default(),
        };

        let mut doubled = manifest.properties.last().unwrap().clone();
        if let format::PropertyDefinition::Formula(fields) = &mut doubled {
            fields.id = "01J00000000000000000000014".to_owned();
            fields.name = "Doubled".to_owned();
            fields.config.expression = "Total * 2".to_owned();
            fields.config.dependencies = vec!["01J00000000000000000000013".to_owned()];
        }
        manifest.properties.push(doubled);
        conn.execute("INSERT INTO db_properties (database_id, property_id, position, name, property_type, page_visibility, config_json) VALUES (?1, '01J00000000000000000000014', 3, 'Doubled', 'formula', 'alwaysShow', '{}')", params![db_id]).unwrap();
        let tx = conn.transaction().unwrap();
        compute_formulas_for_notes(&tx, db_id, &[note_id.to_owned()], &manifest).unwrap();
        tx.commit().unwrap();

        let (val_type, dec_val): (String, String) = conn.query_row(
            "SELECT value_type, decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = '01J00000000000000000000013'",
            params![db_id, note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();

        assert_eq!(val_type, "formula");
        assert_eq!(dec_val, "120");
        let doubled: Result<String, _> = conn.query_row("SELECT decimal_value FROM db_values WHERE database_id = ?1 AND note_id = ?2 AND property_id = '01J00000000000000000000014'", params![db_id, note_id], |row| row.get(0));
        assert_eq!(doubled.ok().as_deref(), Some("240"));
    }
}
