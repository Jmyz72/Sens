//! Expand a repeat rule into calendar dates. A week starts on Monday.

#![cfg_attr(not(test), allow(dead_code))]

use chrono::{Datelike, Days, Months, NaiveDate, NaiveDateTime, NaiveTime, Weekday};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Never,
    After(i32),
    On(NaiveDate),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthMode {
    Each,
    OnThe,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ordinal {
    First,
    #[allow(dead_code)]
    Second,
    #[allow(dead_code)]
    Third,
    #[allow(dead_code)]
    Fourth,
    Fifth,
    Last,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrdinalDay {
    Weekday,
    Weekend,
    WeekdayName(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub start: NaiveDate,
    pub frequency: Freq,
    pub interval: i32,
    pub weekdays: Vec<String>,
    pub month_mode: MonthMode,
    pub month_days: Vec<i32>,
    pub ordinal: Ordinal,
    pub ordinal_day: OrdinalDay,
    pub months: Vec<i32>,
    pub day_of_month: i32,
    pub end: End,
}

/// Dates from the anchor through `through`, inclusive, in calendar order.
///
/// `End::After` stops after that many dates. `End::On` keeps a date equal to
/// the end date and drops later ones. A missing day, such as the 31st in
/// February, is not a date and does not consume an `End::After` count.
pub fn dates_through(rule: &Rule, through: NaiveDate) -> Vec<NaiveDate> {
    if rule.interval < 1 || through < rule.start {
        return Vec::new();
    }
    if let End::After(count) = rule.end {
        if count < 1 {
            return Vec::new();
        }
    }

    let mut out = Vec::new();
    let mut series = Series {
        out: &mut out,
        after: None,
        time: NaiveTime::MIN,
        found: None,
    };
    match rule.frequency {
        Freq::Daily => push_daily(rule, through, &mut series),
        Freq::Weekly => push_weekly(rule, through, &mut series),
        Freq::Monthly => push_monthly(rule, through, &mut series),
        Freq::Yearly => push_yearly(rule, through, &mut series),
    }
    out
}

/// The next datetime in the series strictly after `after`.
///
/// Walks occurrences until one is strictly after `after`. A period with no
/// date, such as the 31st in February or a month with no fifth Friday, does
/// not stop the walk. Returns `None` when the end rule has no later date.
pub fn next_due(rule: &Rule, after: NaiveDateTime, time: NaiveTime) -> Option<NaiveDateTime> {
    if rule.interval < 1 {
        return None;
    }
    if let End::After(count) = rule.end {
        if count < 1 {
            return None;
        }
    }
    let through = match rule.end {
        End::On(end) => end,
        End::Never | End::After(_) => NaiveDate::MAX,
    };
    let mut out = Vec::new();
    let mut series = Series {
        out: &mut out,
        after: Some(after),
        time,
        found: None,
    };
    match rule.frequency {
        Freq::Daily => push_daily(rule, through, &mut series),
        Freq::Weekly => push_weekly(rule, through, &mut series),
        Freq::Monthly => push_monthly(rule, through, &mut series),
        Freq::Yearly => push_yearly(rule, through, &mut series),
    }
    series.found
}

/// Rejects an interval, end, or pattern the schedule form cannot store.
pub fn validate_rule(rule: &Rule) -> Result<(), String> {
    if !(1..=999).contains(&rule.interval) {
        return Err("Repeat interval must be from 1 to 999.".to_string());
    }
    match rule.end {
        End::After(count) if count < 1 => {
            return Err("End count must be at least 1.".to_string());
        }
        End::On(date) if date < rule.start => {
            return Err("End date must be on or after the first date.".to_string());
        }
        _ => {}
    }
    match rule.frequency {
        Freq::Daily => Ok(()),
        Freq::Weekly => {
            if !rule.weekdays.is_empty() && rule.weekdays.iter().all(|day| parse_weekday(day).is_some()) {
                Ok(())
            } else {
                Err("Pick at least one weekday.".to_string())
            }
        }
        Freq::Monthly => match rule.month_mode {
            MonthMode::Each => validate_month_days(&rule.month_days),
            MonthMode::OnThe => validate_ordinal_day(&rule.ordinal_day),
        },
        Freq::Yearly => {
            validate_months(&rule.months)?;
            match rule.month_mode {
                MonthMode::Each => {
                    validate_day_of_month(rule.day_of_month)?;
                    if rule.months.iter().any(|month| rule.day_of_month <= longest_month(*month)) {
                        Ok(())
                    } else {
                        Err("Pick at least one day of the month.".to_string())
                    }
                }
                MonthMode::OnThe => validate_ordinal_day(&rule.ordinal_day),
            }
        }
    }
}

struct Series<'a> {
    out: &'a mut Vec<NaiveDate>,
    after: Option<NaiveDateTime>,
    time: NaiveTime,
    found: Option<NaiveDateTime>,
}

/// `true` means stop: this date is past the window, the end count is full,
/// or `after` already has its next datetime.
fn record(series: &mut Series<'_>, rule: &Rule, through: NaiveDate, date: NaiveDate) -> bool {
    if date < rule.start {
        return false;
    }
    if date > through {
        return true;
    }
    if let End::On(end) = rule.end {
        if date > end {
            return true;
        }
    }
    if let Some(after) = series.after {
        let due = date.and_time(series.time);
        if due > after {
            series.found = Some(due);
            return true;
        }
    }
    series.out.push(date);
    matches!(rule.end, End::After(count) if series.out.len() >= count as usize)
}

fn push_daily(rule: &Rule, through: NaiveDate, series: &mut Series<'_>) {
    let step = Days::new(rule.interval as u64);
    let mut date = rule.start;
    loop {
        if record(series, rule, through, date) {
            return;
        }
        let Some(next) = date.checked_add_days(step) else {
            return;
        };
        date = next;
    }
}

fn push_weekly(rule: &Rule, through: NaiveDate, series: &mut Series<'_>) {
    let Some(mut monday) = week_monday(rule.start) else {
        return;
    };
    let step = Days::new(rule.interval as u64 * 7);
    let offsets = weekday_offsets(&rule.weekdays);
    loop {
        if monday > through {
            return;
        }
        if let End::On(end) = rule.end {
            if monday > end {
                return;
            }
        }
        for offset in &offsets {
            let Some(date) = monday.checked_add_days(Days::new(*offset)) else {
                return;
            };
            if record(series, rule, through, date) {
                return;
            }
        }
        let Some(next) = monday.checked_add_days(step) else {
            return;
        };
        monday = next;
    }
}

fn push_monthly(rule: &Rule, through: NaiveDate, series: &mut Series<'_>) {
    let Some(mut month_start) = rule.start.with_day(1) else {
        return;
    };
    let step = Months::new(rule.interval as u32);
    loop {
        if month_start > through {
            return;
        }
        if let End::On(end) = rule.end {
            if month_start > end {
                return;
            }
        }
        for date in month_dates(month_start, rule) {
            if record(series, rule, through, date) {
                return;
            }
        }
        let Some(next) = month_start.checked_add_months(step) else {
            return;
        };
        month_start = next;
    }
}

fn push_yearly(rule: &Rule, through: NaiveDate, series: &mut Series<'_>) {
    let mut year = rule.start.year();
    loop {
        let Some(jan1) = NaiveDate::from_ymd_opt(year, 1, 1) else {
            return;
        };
        if jan1 > through {
            return;
        }
        if let End::On(end) = rule.end {
            if jan1 > end {
                return;
            }
        }
        for date in year_dates(year, rule) {
            if record(series, rule, through, date) {
                return;
            }
        }
        let Some(next) = year.checked_add(rule.interval) else {
            return;
        };
        year = next;
    }
}

fn month_dates(month_start: NaiveDate, rule: &Rule) -> Vec<NaiveDate> {
    match rule.month_mode {
        MonthMode::Each => {
            let mut days = rule.month_days.clone();
            days.sort_unstable();
            days.dedup();
            days.into_iter()
                .filter_map(|day| day_in_month(month_start, day))
                .collect()
        }
        MonthMode::OnThe => ordinal_in_month(month_start, rule.ordinal, &rule.ordinal_day)
            .into_iter()
            .collect(),
    }
}

fn year_dates(year: i32, rule: &Rule) -> Vec<NaiveDate> {
    let mut months = rule.months.clone();
    months.sort_unstable();
    months.dedup();
    let mut dates = Vec::new();
    for month in months {
        let Some(month_start) = first_of_month(year, month) else {
            continue;
        };
        match rule.month_mode {
            MonthMode::Each => {
                if let Some(date) = day_in_month(month_start, rule.day_of_month) {
                    dates.push(date);
                }
            }
            MonthMode::OnThe => {
                if let Some(date) = ordinal_in_month(month_start, rule.ordinal, &rule.ordinal_day) {
                    dates.push(date);
                }
            }
        }
    }
    dates
}

fn day_in_month(month_start: NaiveDate, day: i32) -> Option<NaiveDate> {
    if (1..=31).contains(&day) {
        month_start.with_day(day as u32)
    } else {
        None
    }
}

fn first_of_month(year: i32, month: i32) -> Option<NaiveDate> {
    if (1..=12).contains(&month) {
        NaiveDate::from_ymd_opt(year, month as u32, 1)
    } else {
        None
    }
}

fn ordinal_in_month(
    month_start: NaiveDate,
    ordinal: Ordinal,
    day: &OrdinalDay,
) -> Option<NaiveDate> {
    let mut hits = Vec::new();
    let mut date = month_start;
    loop {
        if is_ordinal_day(date, day) {
            hits.push(date);
        }
        let Some(next) = date.checked_add_days(Days::new(1)) else {
            break;
        };
        if next.month() != month_start.month() {
            break;
        }
        date = next;
    }
    match ordinal {
        Ordinal::First => hits.first().copied(),
        Ordinal::Second => hits.get(1).copied(),
        Ordinal::Third => hits.get(2).copied(),
        Ordinal::Fourth => hits.get(3).copied(),
        Ordinal::Fifth => hits.get(4).copied(),
        Ordinal::Last => hits.last().copied(),
    }
}

fn is_ordinal_day(date: NaiveDate, day: &OrdinalDay) -> bool {
    match day {
        OrdinalDay::Weekday => !matches!(date.weekday(), Weekday::Sat | Weekday::Sun),
        OrdinalDay::Weekend => matches!(date.weekday(), Weekday::Sat | Weekday::Sun),
        OrdinalDay::WeekdayName(name) => {
            parse_weekday(name).is_some_and(|weekday| date.weekday() == weekday)
        }
    }
}

fn week_monday(date: NaiveDate) -> Option<NaiveDate> {
    date.checked_sub_days(Days::new(date.weekday().num_days_from_monday() as u64))
}

fn weekday_offsets(names: &[String]) -> Vec<u64> {
    let mut offsets: Vec<u64> = names
        .iter()
        .filter_map(|name| parse_weekday(name).map(|day| day.num_days_from_monday() as u64))
        .collect();
    offsets.sort_unstable();
    offsets.dedup();
    offsets
}

fn parse_weekday(name: &str) -> Option<Weekday> {
    match name {
        "mon" => Some(Weekday::Mon),
        "tue" => Some(Weekday::Tue),
        "wed" => Some(Weekday::Wed),
        "thu" => Some(Weekday::Thu),
        "fri" => Some(Weekday::Fri),
        "sat" => Some(Weekday::Sat),
        "sun" => Some(Weekday::Sun),
        _ => None,
    }
}

fn validate_month_days(days: &[i32]) -> Result<(), String> {
    if !days.is_empty() && days.iter().all(|day| (1..=31).contains(day)) {
        Ok(())
    } else {
        Err("Pick at least one day of the month.".to_string())
    }
}

fn validate_months(months: &[i32]) -> Result<(), String> {
    if !months.is_empty() && months.iter().all(|month| (1..=12).contains(month)) {
        Ok(())
    } else {
        Err("Pick at least one month.".to_string())
    }
}

/// The most days month `month` (1..=12) can have, counting February as 29.
fn longest_month(month: i32) -> i32 {
    match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn validate_day_of_month(day: i32) -> Result<(), String> {
    if (1..=31).contains(&day) {
        Ok(())
    } else {
        Err("Pick at least one day of the month.".to_string())
    }
}

fn validate_ordinal_day(day: &OrdinalDay) -> Result<(), String> {
    match day {
        OrdinalDay::Weekday | OrdinalDay::Weekend => Ok(()),
        OrdinalDay::WeekdayName(name) if parse_weekday(name).is_some() => Ok(()),
        OrdinalDay::WeekdayName(_) => Err("Pick at least one weekday.".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

    use super::{
        dates_through, next_due, validate_rule, End, Freq, MonthMode, Ordinal, OrdinalDay, Rule,
    };

    fn rule_daily(start: &str, interval: i32, end: End) -> Rule {
        Rule {
            start: NaiveDate::parse_from_str(start, "%Y-%m-%d").unwrap(),
            frequency: Freq::Daily,
            interval,
            weekdays: vec![],
            month_mode: MonthMode::Each,
            month_days: vec![],
            ordinal: Ordinal::First,
            ordinal_day: OrdinalDay::Weekday,
            months: vec![],
            day_of_month: 1,
            end,
        }
    }

    #[test]
    fn daily_every_day_and_every_second_day() {
        let through = NaiveDate::from_ymd_opt(2026, 10, 5).unwrap();
        let every = dates_through(&rule_daily("2026-10-01", 1, End::Never), through);
        assert_eq!(
            ymd(&every),
            vec!["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]
        );
        let step = dates_through(&rule_daily("2026-10-01", 2, End::Never), through);
        assert_eq!(ymd(&step), vec!["2026-10-01", "2026-10-03", "2026-10-05"]);
    }

    #[test]
    fn daily_end_on_is_inclusive_and_after_counts_dates() {
        let through = NaiveDate::from_ymd_opt(2026, 12, 1).unwrap();
        let on = dates_through(
            &rule_daily(
                "2026-10-01",
                1,
                End::On(NaiveDate::from_ymd_opt(2026, 10, 3).unwrap()),
            ),
            through,
        );
        assert_eq!(ymd(&on), vec!["2026-10-01", "2026-10-02", "2026-10-03"]);
        let after = dates_through(&rule_daily("2026-10-01", 1, End::After(3)), through);
        assert_eq!(after.len(), 3);
    }

    fn ymd(dates: &[NaiveDate]) -> Vec<String> {
        dates.iter().map(|d| d.format("%Y-%m-%d").to_string()).collect()
    }
    fn through(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn weekly_friday_and_every_second_week_on_two_days() {
        let mut fri = rule_daily("2026-10-02", 1, End::Never);
        fri.frequency = Freq::Weekly;
        fri.weekdays = vec!["fri".into()];
        assert_eq!(
            ymd(&dates_through(&fri, through("2026-10-16"))),
            vec!["2026-10-02", "2026-10-09", "2026-10-16"]
        );
        let mut both = rule_daily("2026-10-02", 2, End::Never);
        both.frequency = Freq::Weekly;
        both.weekdays = vec!["mon".into(), "fri".into()];
        assert_eq!(
            ymd(&dates_through(&both, through("2026-10-20"))),
            vec!["2026-10-02", "2026-10-12", "2026-10-16"]
        );
        let mut later = rule_daily("2026-10-07", 1, End::Never);
        later.frequency = Freq::Weekly;
        later.weekdays = vec!["mon".into()];
        assert_eq!(
            ymd(&dates_through(&later, through("2026-10-20"))),
            vec!["2026-10-12", "2026-10-19"]
        );
    }

    #[test]
    fn monthly_skips_missing_days_and_anchors_to_the_start_month() {
        let mut thirty_first = rule_daily("2026-01-01", 1, End::Never);
        thirty_first.frequency = Freq::Monthly;
        thirty_first.month_mode = MonthMode::Each;
        thirty_first.month_days = vec![31];
        assert_eq!(
            ymd(&dates_through(&thirty_first, through("2026-04-30"))),
            vec!["2026-01-31", "2026-03-31"]
        );
        let mut fifth = rule_daily("2026-10-15", 2, End::Never);
        fifth.frequency = Freq::Monthly;
        fifth.month_days = vec![5];
        assert_eq!(
            ymd(&dates_through(&fifth, through("2027-02-28"))),
            vec!["2026-12-05", "2027-02-05"]
        );
    }

    #[test]
    fn monthly_on_the_fifth_friday_first_weekday_and_last_weekend() {
        let mut fifth = rule_daily("2026-01-01", 1, End::Never);
        fifth.frequency = Freq::Monthly;
        fifth.month_mode = MonthMode::OnThe;
        fifth.ordinal = Ordinal::Fifth;
        fifth.ordinal_day = OrdinalDay::WeekdayName("fri".into());
        assert_eq!(
            ymd(&dates_through(&fifth, through("2026-05-31"))),
            vec!["2026-01-30", "2026-05-29"]
        );
        let mut first = rule_daily("2026-10-01", 1, End::Never);
        first.frequency = Freq::Monthly;
        first.month_mode = MonthMode::OnThe;
        first.ordinal = Ordinal::First;
        first.ordinal_day = OrdinalDay::Weekday;
        assert_eq!(
            ymd(&dates_through(&first, through("2026-11-30"))),
            vec!["2026-10-01", "2026-11-02"]
        );
        let mut last = rule_daily("2026-09-01", 1, End::Never);
        last.frequency = Freq::Monthly;
        last.month_mode = MonthMode::OnThe;
        last.ordinal = Ordinal::Last;
        last.ordinal_day = OrdinalDay::Weekend;
        assert_eq!(
            ymd(&dates_through(&last, through("2026-10-31"))),
            vec!["2026-09-27", "2026-10-31"]
        );
    }

    #[test]
    fn yearly_on_2_october() {
        let mut year = rule_daily("2026-10-02", 1, End::Never);
        year.frequency = Freq::Yearly;
        year.month_mode = MonthMode::Each;
        year.months = vec![10];
        year.day_of_month = 2;
        assert_eq!(
            ymd(&dates_through(&year, through("2028-10-02"))),
            vec!["2026-10-02", "2027-10-02", "2028-10-02"]
        );
    }

    #[test]
    fn validate_rule_rejects_empty_patterns_and_a_bad_end() {
        let mut weekly = rule_daily("2026-10-02", 1, End::Never);
        weekly.frequency = Freq::Weekly;
        assert_eq!(validate_rule(&weekly).unwrap_err(), "Pick at least one weekday.");
        let mut monthly = rule_daily("2026-10-02", 1, End::Never);
        monthly.frequency = Freq::Monthly;
        monthly.month_days = vec![];
        assert_eq!(validate_rule(&monthly).unwrap_err(), "Pick at least one day of the month.");
        let mut yearly = rule_daily("2026-10-02", 1, End::Never);
        yearly.frequency = Freq::Yearly;
        yearly.months = vec![];
        assert_eq!(validate_rule(&yearly).unwrap_err(), "Pick at least one month.");
        assert_eq!(
            validate_rule(&rule_daily("2026-10-02", 0, End::Never)).unwrap_err(),
            "Repeat interval must be from 1 to 999."
        );
        assert_eq!(
            validate_rule(&rule_daily("2026-10-02", 1000, End::Never)).unwrap_err(),
            "Repeat interval must be from 1 to 999."
        );
        assert_eq!(
            validate_rule(&rule_daily("2026-10-02", 1, End::On(through("2026-10-01"))))
                .unwrap_err(),
            "End date must be on or after the first date."
        );
        assert_eq!(
            validate_rule(&rule_daily("2026-10-02", 1, End::After(0))).unwrap_err(),
            "End count must be at least 1."
        );
    }

    #[test]
    fn validate_rule_rejects_any_bad_token_and_an_impossible_yearly_day() {
        let mut weekly = rule_daily("2026-10-02", 1, End::Never);
        weekly.frequency = Freq::Weekly;
        weekly.weekdays = vec!["mon".into(), "funday".into()];
        assert_eq!(validate_rule(&weekly).unwrap_err(), "Pick at least one weekday.");
        weekly.weekdays = vec!["mon".into()];
        assert!(validate_rule(&weekly).is_ok());

        let mut monthly = rule_daily("2026-10-02", 1, End::Never);
        monthly.frequency = Freq::Monthly;
        monthly.month_days = vec![5, 32];
        assert_eq!(validate_rule(&monthly).unwrap_err(), "Pick at least one day of the month.");
        monthly.month_days = vec![5, 0];
        assert_eq!(validate_rule(&monthly).unwrap_err(), "Pick at least one day of the month.");

        let mut yearly = rule_daily("2026-10-02", 1, End::Never);
        yearly.frequency = Freq::Yearly;
        yearly.months = vec![10, 13];
        yearly.day_of_month = 2;
        assert_eq!(validate_rule(&yearly).unwrap_err(), "Pick at least one month.");
        yearly.months = vec![2];
        yearly.day_of_month = 30;
        assert_eq!(validate_rule(&yearly).unwrap_err(), "Pick at least one day of the month.");
        yearly.months = vec![2, 4];
        assert!(validate_rule(&yearly).is_ok());
        yearly.months = vec![2];
        yearly.day_of_month = 29;
        assert!(validate_rule(&yearly).is_ok());
    }

    #[test]
    fn next_due_waits_for_the_time_then_moves_to_the_next_date() {
        let rule = rule_daily("2026-10-01", 1, End::Never);
        let morning = NaiveDateTime::parse_from_str("2026-10-25T08:00", "%Y-%m-%dT%H:%M").unwrap();
        let at_nine = NaiveDateTime::parse_from_str("2026-10-25T09:00", "%Y-%m-%dT%H:%M").unwrap();
        let nine = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
        assert_eq!(next_due(&rule, morning, nine).unwrap(), at_nine);
        assert_eq!(
            next_due(&rule, at_nine, nine).unwrap(),
            NaiveDateTime::parse_from_str("2026-10-26T09:00", "%Y-%m-%dT%H:%M").unwrap()
        );
    }

    #[test]
    fn next_due_walks_past_empty_periods_until_a_real_date_or_the_end() {
        let nine = NaiveTime::from_hms_opt(9, 0, 0).unwrap();

        let mut month_end = rule_daily("2026-01-01", 1, End::Never);
        month_end.frequency = Freq::Monthly;
        month_end.month_mode = MonthMode::Each;
        month_end.month_days = vec![31];
        assert_eq!(
            next_due(
                &month_end,
                NaiveDateTime::parse_from_str("2026-01-31T09:00", "%Y-%m-%dT%H:%M").unwrap(),
                nine,
            )
            .unwrap(),
            NaiveDateTime::parse_from_str("2026-03-31T09:00", "%Y-%m-%dT%H:%M").unwrap()
        );

        let mut fifth = rule_daily("2026-01-01", 1, End::Never);
        fifth.frequency = Freq::Monthly;
        fifth.month_mode = MonthMode::OnThe;
        fifth.ordinal = Ordinal::Fifth;
        fifth.ordinal_day = OrdinalDay::WeekdayName("fri".into());
        assert_eq!(
            next_due(
                &fifth,
                NaiveDateTime::parse_from_str("2026-01-30T09:00", "%Y-%m-%dT%H:%M").unwrap(),
                nine,
            )
            .unwrap(),
            NaiveDateTime::parse_from_str("2026-05-29T09:00", "%Y-%m-%dT%H:%M").unwrap()
        );

        let once = rule_daily("2026-10-01", 1, End::After(1));
        assert_eq!(
            next_due(
                &once,
                NaiveDateTime::parse_from_str("2026-10-01T09:00", "%Y-%m-%dT%H:%M").unwrap(),
                nine,
            ),
            None
        );
    }
}
