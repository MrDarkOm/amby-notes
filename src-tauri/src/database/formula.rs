//! Small deterministic formula language for computed database fields.
//!
//! It is intentionally interpreted in Rust instead of being handed to
//! JavaScript or SQLite. The evaluator has bounded input and recursion, exact
//! decimal arithmetic, and no access to files, the network, or the clock.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fmt;

const MAX_TOKENS: usize = 4096;
const MAX_DEPTH: usize = 64;
const MAX_SCALE: u32 = 18;

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

    fn add(&self, other: &Self) -> Result<Self, FormulaError> {
        let (left, right, scale) = self.align(other)?;
        left.checked_add(right)
            .map(|value| Self::new(value, scale))
            .ok_or_else(|| FormulaError::new("numberOverflow", "decimal operation overflowed"))
    }

    fn sub(&self, other: &Self) -> Result<Self, FormulaError> {
        let (left, right, scale) = self.align(other)?;
        left.checked_sub(right)
            .map(|value| Self::new(value, scale))
            .ok_or_else(|| FormulaError::new("numberOverflow", "decimal operation overflowed"))
    }

    fn mul(&self, other: &Self) -> Result<Self, FormulaError> {
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

    fn div(&self, other: &Self) -> Result<Self, FormulaError> {
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

    fn cmp(&self, other: &Self) -> Result<std::cmp::Ordering, FormulaError> {
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
                ))
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
                    ))
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
