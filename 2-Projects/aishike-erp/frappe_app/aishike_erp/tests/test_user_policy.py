from __future__ import annotations

import unittest

from aishike_erp.user_policy import is_allowed_employee_email


class EmployeeEmailPolicyTest(unittest.TestCase):
    def test_accepts_futurus_employee_email(self) -> None:
        self.assertTrue(is_allowed_employee_email("rayman.chen@futurus.co"))

    def test_email_check_is_case_insensitive(self) -> None:
        self.assertTrue(is_allowed_employee_email("Rayman.Chen@FUTURUS.CO"))

    def test_rejects_external_domain(self) -> None:
        self.assertFalse(is_allowed_employee_email("employee@example.com"))

    def test_rejects_subdomain(self) -> None:
        self.assertFalse(is_allowed_employee_email("employee@mail.futurus.co"))

    def test_rejects_suffix_attack(self) -> None:
        self.assertFalse(is_allowed_employee_email("employee@futurus.co.example.com"))


if __name__ == "__main__":
    unittest.main()
